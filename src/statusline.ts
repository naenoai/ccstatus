// Status bar segment assembly. This module must not import `vscode` — it is
// loaded directly by the unit tests, which run in a plain Node process with no
// editor host. The extension reads its configuration and hands the values in as
// a plain object, so which segments appear is decidable without an editor.

import {
  colorThreshold,
  formatDuration,
  formatTokenCount,
  formatWindowSize,
  progressBar,
  resolveBarWidth,
  type BarStyle,
} from './format';
import { rateLimitSegments, type ResolvedRateLimits } from './ratelimits';

// Only the fields the status bar actually renders. The extension's own
// StatusData carries more — the cwd and source the tooltip needs, the raw model
// identifier — and none of it belongs in the contract for building a line.
export interface StatusData {
  model: string;
  // The reasoning effort the session is running at, when the transcript said
  // so. Empty whenever it did not: Claude Code only began recording effort
  // recently, and the statusline payload never carries it, so absence is the
  // normal state for older sessions rather than a fault worth rendering.
  effort: string;
  contextPct: number;
  contextWindow: number;
  contextTokens: number;
  branch: string | null;
  limits: ResolvedRateLimits;
  sessionMin: number | null;
  folder: string;
  subscriptionType: string;
  claudeCodeInstalled: boolean;
  cacheStale: boolean;
}

export interface SegmentSettings {
  showModel: boolean;
  showEffort: boolean;
  showContextBar: boolean;
  barWidth: string;
  barStyle: string;
  showRateLimits: boolean;
  showSessionReset: boolean;
  showWeeklyReset: boolean;
  showGitBranch: boolean;
  showSessionDuration: boolean;
  showFolder: boolean;
  showSubscription: boolean;
}

const SEPARATOR = '  │  ';

const PLAN_LABELS: Record<string, string> = {
  pro: 'Pro', team: 'Team', enterprise: 'Ent', free: 'Free',
};

export function buildStatusText(data: StatusData, s: SegmentSettings): string {
  const parts: string[] = [];

  // Without Claude Code every reading on the line would be invented, so the
  // item names itself and reports only what can be observed without it. The
  // folder honours its setting here too: an exception on this path would make
  // the setting mean something different depending on a state the user did not
  // choose and may not know they are in.
  if (!data.claudeCodeInstalled) {
    parts.push(`$(sparkle) Claude`);
    if (s.showGitBranch && data.branch) { parts.push(`$(git-branch) ${data.branch}`); }
    if (s.showFolder) { parts.push(`$(folder) ${data.folder}`); }
    return parts.join(SEPARATOR);
  }

  // Effort qualifies the model rather than standing beside it — "Opus 5 high"
  // is one fact about how this session is running, and any separator would read
  // as a second, unrelated measurement. It therefore rides inside the model
  // segment and cannot appear when the model is hidden.
  if (s.showModel) {
    const effort = s.showEffort && data.effort ? ` ${data.effort}` : '';
    parts.push(`$(sparkle) ${data.model}${effort}`);
  }
  if (s.showContextBar) {
    const width = resolveBarWidth(s.barWidth);
    const style = s.barStyle as BarStyle;
    // The absolute figure, the at-a-glance read, and the precise scalar — each
    // answers a question the other two cannot.
    parts.push(`${formatTokenCount(data.contextTokens)} / ${formatWindowSize(data.contextWindow)}`);
    parts.push(`${colorThreshold(data.contextPct)}${progressBar(data.contextPct, width, style)} ${data.contextPct}%`);
  }

  if (s.showRateLimits) {
    parts.push(...rateLimitSegments(data.limits, data.cacheStale, {
      showSessionReset: s.showSessionReset,
      showWeeklyReset: s.showWeeklyReset,
    }));
  }

  if (s.showGitBranch && data.branch) { parts.push(`$(git-branch) ${data.branch}`); }
  if (s.showSessionDuration && data.sessionMin !== null) { parts.push(`$(clock) ${formatDuration(data.sessionMin)}`); }
  if (s.showFolder) { parts.push(`$(folder) ${data.folder}`); }
  if (s.showSubscription && data.subscriptionType) {
    parts.push(`$(verified) ${PLAN_LABELS[data.subscriptionType] ?? data.subscriptionType}`);
  }

  // Every segment is individually optional, so they can all be off at once. An
  // empty string renders as a blank gap the user cannot click or hover, which
  // would strip access to the tooltip and commands; naming the extension is the
  // smallest thing that keeps the item reachable.
  if (parts.length === 0) { return `$(sparkle) Claude`; }

  return parts.join(SEPARATOR);
}
