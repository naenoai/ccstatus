// Pure rendering helpers. This module must not import `vscode` — it is loaded
// directly by the unit tests, which run in a plain Node process with no editor host.

export function colorThreshold(pct: number): string {
  if (pct >= 80) { return '$(error)'; }
  if (pct >= 50) { return '$(warning)'; }
  return '';
}

// Eighth-block characters, indexed by eighths of a character: EIGHTHS[3] is
// three-eighths full. Index 0 is empty and never rendered as fill.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

export type BarStyle = 'minimal' | 'solid' | 'hatched' | 'blocks' | 'faint';

// `solid` resolves to an eighth of a character; the rest are whole-character
// only, trading resolution for appearance. `hatched` and `blocks` differ solely
// in fill glyph — `hatched` is the lower-contrast variant.
//
// `minimal` runs the fill along a box-drawing rule instead of a shaded cell.
// `░` is a stipple that the proportional UI font draws with its own cell edges,
// so a row of them reads as a strip of separate squares rather than the empty
// remainder of one bar; `─` has no interior, joins to its neighbours, and
// recedes to the trough the fill sits in.
const STYLES: Record<BarStyle, { fill: string; track: string; steps: number }> = {
  minimal: { fill: '█', track: '─', steps: 1 },
  solid:   { fill: '█', track: '·', steps: 8 },
  hatched: { fill: '▓', track: '░', steps: 1 },
  blocks:  { fill: '█', track: '░', steps: 1 },
  faint:   { fill: '░', track: '·', steps: 1 },
};

export type BarWidth = 'small' | 'medium' | 'large' | 'xl';

// Width is offered as named sizes because a raw number gives the user nothing
// to reason about — there is no guessing what "12" looks like in a status bar.
// `medium` is the width the bar has always had, so an upgrade that touches no
// settings shifts no layout.
const BAR_WIDTHS: Record<BarWidth, number> = {
  small: 5, medium: 10, large: 15, xl: 20,
};

export function resolveBarWidth(name: string): number {
  return BAR_WIDTHS[name as BarWidth] ?? BAR_WIDTHS.medium;
}

// `minimal` is the default rather than `solid`, despite `solid` measuring eight
// times finer. The accuracy `solid` reports is measured in logical eighths and
// only reaches the screen in a monospace font; the status bar renders in the
// proportional UI font, where the eighth-block partials (`▎`, `▌`, `▉`) carry no
// guaranteed advance width and commonly fall back to a font that draws them at a
// full cell. A 23% bar then paints three solid cells and reads as ~30% — the bar
// overstating progress, which is the one direction the truncation below exists
// to rule out.
//
// That argument rules out `solid` but not the shaded whole-character styles;
// what rules those out is how the track reads. A `░` run is drawn as a series of
// bordered cells, so the unfilled remainder competes with the fill for attention
// and the bar as a whole reads as a row of squares. `minimal` keeps the whole-
// character fill and its uniform advance width, and spends the track on a rule
// that stays visually subordinate to it.
export function progressBar(pct: number, width = 10, style: BarStyle = 'minimal'): string {
  const { fill, track, steps } = STYLES[style] ?? STYLES.minimal;
  // The percentage is derived from parsed transcript data, so a missing or
  // malformed figure arrives as NaN. Treat it as empty rather than letting it
  // propagate into repeat() and throw.
  const clamped = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  const total = width * steps;

  // Truncate rather than round: a unit appears only once it has actually been
  // earned, so a partly-filled unit never overstates progress. This is what
  // keeps the bar honest against the percentage printed beside it.
  let units = Math.floor((clamped / 100) * total);

  // Endpoint clamps: any non-zero percentage shows at least one unit of fill,
  // and anything short of 100 leaves at least one unit unfilled. Whether the
  // ceiling has actually been reached is the bar's most important signal.
  if (clamped > 0) { units = Math.max(units, 1); }
  if (clamped < 100) { units = Math.min(units, total - 1); }

  const whole = Math.floor(units / steps);
  // Only `solid` has sub-character steps; for the others the remainder is
  // always 0, so EIGHTHS[0] correctly contributes nothing.
  const partial = steps === 8 ? EIGHTHS[units % steps] : '';

  return fill.repeat(whole) + partial + track.repeat(width - whole - (partial ? 1 : 0));
}

// The numerator of the context readout. Below a thousand it keeps one decimal,
// because a fresh session rounded to thousands reads `0k` for its whole opening
// stretch — a number that looks like the extension is broken rather than idle.
// At or above a thousand it rounds to whole thousands instead: the status bar
// redraws every few seconds, and a trailing decimal on a six-figure count would
// churn on every refresh without informing any decision.
export function formatTokenCount(tokens: number): string {
  const k = tokens / 1000;
  return k < 1 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

// The denominator of the context readout. Unlike the numerator this is a fixed,
// round figure the user already knows, so it carries no decimal — and a
// million-token window renders as `1M`, the unit people actually say it in.
export function formatWindowSize(tokens: number): string {
  return tokens >= 1_000_000
    ? `${Math.round(tokens / 1_000_000)}M`
    : `${Math.round(tokens / 1000)}k`;
}

// The count shown beside the bar has to be derived from whatever produced the
// percentage, or the two can disagree on screen — a bar reading 68% next to a
// count reading 40k is worse than showing no count at all.
export function resolveContextTokens(reading: {
  pct: number;
  window: number;
  transcriptTokens: number;
  fromTranscript: boolean;
}): number {
  if (reading.fromTranscript) { return reading.transcriptTokens; }
  // Nothing parsed this reading, so the transcript total beside it describes a
  // different measurement. Rebuilding from the percentage makes count and bar
  // the same number by construction.
  return Math.round((reading.pct / 100) * reading.window);
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) { return `${minutes}m`; }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

export function formatCountdown(raw: string | null): string {
  if (!raw) { return ''; }
  try {
    let ms: number;
    const n = Number(raw);
    if (!isNaN(n) && isFinite(n)) {
      ms = (n < 1e10 ? n * 1000 : n) - Date.now();
    } else {
      ms = new Date(raw).getTime() - Date.now();
    }
    if (!isFinite(ms) || ms <= 0) { return ''; }
    const totalMins = Math.floor(ms / 60000);
    if (totalMins < 60) { return `${totalMins}m`; }
    const totalHours = Math.floor(totalMins / 60);
    // The weekly window puts resets days out, where an hour count stops being
    // readable — "76h" is arithmetic the reader should not have to do. Each
    // scale drops the unit below it, which at days out no longer informs
    // any decision.
    if (totalHours >= 24) {
      const d = Math.floor(totalHours / 24);
      const h = totalHours % 24;
      return `${d}d${h > 0 ? ` ${h}h` : ''}`;
    }
    const m = totalMins % 60;
    return `${totalHours}h${m > 0 ? ` ${m}m` : ''}`;
  } catch { return ''; }
}

export function prettifyModelName(raw: string): string {
  if (!raw || raw === 'Claude') { return 'Claude'; }
  let s = raw.replace(/\[\d+[kmb]?\]$/i, '').trim();
  s = s.replace(/-\d{8}$/, '').replace(/-latest$/, '');
  s = s.replace(/^claude-/, '');
  const m = s.match(/^(sonnet|opus|haiku)-(\d+)(?:-(\d+))?/i);
  if (m) {
    const fam = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    return m[3] ? `${fam} ${m[2]}.${m[3]}` : `${fam} ${m[2]}`;
  }
  // Already a display name like "Sonnet 4.6" or "Opus"
  return s.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
}

const DEFAULT_CONTEXT_WINDOW = 200_000;

// Accepts the forms a human or a model string would write a window size in:
// `1M`, `200k`, or a plain token count. Returns null for anything else, so a
// malformed value falls through to the next source rather than becoming a
// nonsense denominator.
function parseWindowSize(raw: string): number | null {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
  if (!m) { return null; }
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase() ?? ''] ?? 1;
  const n = Math.round(Number(m[1]) * scale);
  return n > 0 ? n : null;
}

// Models served with a 1M window. Matched as substrings against the raw model
// identifier, so both bare aliases (`claude-opus-5`) and the dated snapshots
// and provider-prefixed forms that embed them (`anthropic.claude-sonnet-5`)
// resolve. Anything absent falls back to the 200k default, which is the safe
// direction to be wrong in: it overstates usage rather than headroom.
//
// Haiku is deliberately absent — it remains a 200k model — as are Opus 4.5 and
// earlier and Sonnet 4.5 and earlier.
const LONG_CONTEXT_MODELS = [
  'opus-5', 'opus-4-6', 'opus-4-7', 'opus-4-8',
  'sonnet-5', 'sonnet-4-6',
  'fable-5', 'mythos-5', 'mythos-preview',
];

// Resolves the context window denominator in precedence order: an explicit
// user override, then whatever the model identifier reveals, then the 200k
// default. Each tier falls through when it has nothing usable to say.
export function resolveContextWindow(rawModel: string, override?: string): number {
  if (override) {
    const parsed = parseWindowSize(override);
    if (parsed) { return parsed; }
  }

  const suffix = rawModel.match(/\[(\d+[kmb]?)\]\s*$/i);
  if (suffix) {
    const parsed = parseWindowSize(suffix[1]);
    if (parsed) { return parsed; }
  }

  const id = rawModel.toLowerCase();
  if (LONG_CONTEXT_MODELS.some(m => id.includes(m))) { return 1_000_000; }

  return DEFAULT_CONTEXT_WINDOW;
}
