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

export type BarStyle = 'solid' | 'hatched' | 'blocks' | 'faint';

// `solid` resolves to an eighth of a character; the rest are whole-character
// only, trading resolution for appearance. `hatched` and `blocks` differ solely
// in fill glyph — `hatched` is the lower-contrast variant.
const STYLES: Record<BarStyle, { fill: string; track: string; steps: number }> = {
  solid:   { fill: '█', track: '·', steps: 8 },
  hatched: { fill: '▓', track: '░', steps: 1 },
  blocks:  { fill: '█', track: '░', steps: 1 },
  faint:   { fill: '░', track: '·', steps: 1 },
};

export function progressBar(pct: number, width = 10, style: BarStyle = 'solid'): string {
  const { fill, track, steps } = STYLES[style] ?? STYLES.solid;
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
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return `${h}h${m > 0 ? ` ${m}m` : ''}`;
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
