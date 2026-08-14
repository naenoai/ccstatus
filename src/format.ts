// Pure rendering helpers. This module must not import `vscode` — it is loaded
// directly by the unit tests, which run in a plain Node process with no editor host.

export function colorThreshold(pct: number): string {
  if (pct >= 80) { return '$(error)'; }
  if (pct >= 50) { return '$(warning)'; }
  return '';
}

export function progressBar(pct: number, blocks = 10): string {
  const filled = Math.round((pct / 100) * blocks);
  return '█'.repeat(filled) + '·'.repeat(blocks - filled);
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
