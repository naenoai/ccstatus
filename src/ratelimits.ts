// Rate limit resolution. This module must not import `vscode` — it is loaded
// directly by the unit tests, which run in a plain Node process with no editor
// host.
//
// The central distinction: an absent window means "unknown" and is rendered by
// omission. Only a window that resolves to a value was actually measured.

import { colorThreshold } from './format';

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
export function rateLimitSegments(limits: ResolvedRateLimits, stale: boolean): string[] {
  const mark = stale ? '~' : '';
  const segments: string[] = [];
  // Colouring is applied per known window, so an omitted one cannot be coloured
  // on the strength of a value that was never measured.
  if (limits.session) { segments.push(`${colorThreshold(limits.session.pct)}Session:${mark}${limits.session.pct}%`); }
  if (limits.weekly) { segments.push(`${colorThreshold(limits.weekly.pct)}Weekly:${mark}${limits.weekly.pct}%`); }
  return segments;
}

// A percentage of zero is only believable when a reset time accompanies it.
// Without one, the figure is a default standing in for data that never arrived.
function fromCache(pct: number | null | undefined, resetsAt: string | null | undefined): RateWindow | null {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) { return null; }
  if (pct === 0 && !resetsAt) { return null; }
  return { pct, resetsAt: resetsAt || null };
}
