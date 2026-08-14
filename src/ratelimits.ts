// Rate limit resolution. This module must not import `vscode` — it is loaded
// directly by the unit tests, which run in a plain Node process with no editor
// host.
//
// The central distinction: an absent window means "unknown" and is rendered by
// omission. Only a window that resolves to a value was actually measured.

import { colorThreshold, formatCountdown } from './format';

export interface RateWindow {
  pct: number;
  resetsAt: string | null;
}

export interface RateCacheFields {
  r5?: number | null;
  r7?: number | null;
  r5_resets_at?: string | null;
  r7_resets_at?: string | null;
}

export interface OAuthUsageFields {
  five_hour?: { utilization: number; resets_at: string | null };
  seven_day?: { utilization: number; resets_at: string | null };
}

export interface RateLimitSources {
  cache: RateCacheFields | null;
  oauth: OAuthUsageFields | null;
}

export interface ResolvedRateLimits {
  session: RateWindow | null;
  weekly: RateWindow | null;
}

// Each countdown is controlled independently: how long until the session
// window resets and how long until the weekly one does are different
// questions, and a reader may want one without the other.
export interface CountdownSettings {
  showSessionReset: boolean;
  showWeeklyReset: boolean;
}

const NO_COUNTDOWNS: CountdownSettings = { showSessionReset: false, showWeeklyReset: false };

export function resolveRateLimits(sources: RateLimitSources): ResolvedRateLimits {
  const { cache, oauth } = sources;
  return {
    session: fromCache(cache?.r5, cache?.r5_resets_at) ?? fromOAuth(oauth?.five_hour),
    weekly: fromCache(cache?.r7, cache?.r7_resets_at) ?? fromOAuth(oauth?.seven_day),
  };
}

// Utilisation arrives fractional from the API; the status bar deals in whole
// percents. Unlike the cache, a zero here was actually measured, so it stands
// on its own without needing a reset time to corroborate it.
function fromOAuth(window: { utilization: number; resets_at: string | null } | undefined): RateWindow | null {
  if (!window || typeof window.utilization !== 'number' || !Number.isFinite(window.utilization)) { return null; }
  return { pct: Math.round(window.utilization), resetsAt: window.resets_at || null };
}

// Renders the rate limit portion of the status bar. Returns one segment per
// known window and nothing for unknown ones, so absence is how the status bar
// says "unknown" — there is no placeholder to occupy width permanently.
export function rateLimitSegments(
  limits: ResolvedRateLimits,
  stale: boolean,
  countdowns: CountdownSettings = NO_COUNTDOWNS,
): string[] {
  const mark = stale ? '~' : '';
  return [
    ...windowSegments(limits.session, 'Session', mark, countdowns.showSessionReset),
    ...windowSegments(limits.weekly, 'Weekly', mark, countdowns.showWeeklyReset),
  ];
}

// One window's contribution: its percentage, then its countdown directly after
// it. Keeping the pair together here is what guarantees a countdown can never
// drift away from the percentage it describes.
function windowSegments(
  window: RateWindow | null,
  label: string,
  mark: string,
  showCountdown: boolean,
): string[] {
  // Colouring is applied per known window, so an omitted one cannot be coloured
  // on the strength of a value that was never measured.
  if (!window) { return []; }
  const segments = [`${colorThreshold(window.pct)}${label}:${mark}${window.pct}%`];

  // A window with no reset time — or one already past — contributes no
  // countdown: the same availability rule that governs the percentages,
  // applied one level down. Staleness never marks a countdown, because the
  // reset time is an absolute instant rather than an ageing measurement.
  if (showCountdown) {
    const remaining = formatCountdown(window.resetsAt);
    if (remaining) { segments.push(`↻ ${remaining}`); }
  }
  return segments;
}

// A percentage of zero is only believable when a reset time accompanies it.
// Without one, the figure is a default standing in for data that never arrived.
function fromCache(pct: number | null | undefined, resetsAt: string | null | undefined): RateWindow | null {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) { return null; }
  if (pct === 0 && !resetsAt) { return null; }
  return { pct, resetsAt: resetsAt || null };
}
