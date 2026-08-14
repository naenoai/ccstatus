import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStatusText, type SegmentSettings, type StatusData } from './statusline';
import * as manifest from '../package.json';

// The settings a user who has changed nothing is running with. Tests state only
// the settings they are about, so a default that drifts is caught by the tests
// that assert on the default line rather than silently absorbed everywhere.
const DEFAULTS: SegmentSettings = {
  showModel: true,
  showContextBar: true,
  barWidth: 'medium',
  barStyle: 'solid',
  showRateLimits: true,
  showSessionReset: true,
  showWeeklyReset: true,
  showGitBranch: false,
  showSessionDuration: true,
  showFolder: false,
  showSubscription: true,
};

const DATA: StatusData = {
  model: 'Opus 5',
  contextPct: 68,
  contextWindow: 200_000,
  contextTokens: 136_000,
  branch: 'main',
  limits: {
    session: { pct: 12, resetsAt: null },
    weekly: { pct: 30, resetsAt: null },
  },
  sessionMin: 42,
  folder: 'ccstatus',
  subscriptionType: 'pro',
  claudeCodeInstalled: true,
  cacheStale: false,
};

function settings(overrides: Partial<SegmentSettings> = {}): SegmentSettings {
  return { ...DEFAULTS, ...overrides };
}

// VS Code already names the workspace in the title bar, the Explorer, and the
// window title. A fourth copy in the status bar is width spent on something the
// user is already looking at.
test('the folder is hidden unless asked for', () => {
  assert.doesNotMatch(buildStatusText(DATA, settings()), /ccstatus/);
});

// Hiding it by default removes a segment some users relied on. The capability
// has to survive the default change, or this is a deletion wearing a setting.
test('the folder comes back when the setting asks for it', () => {
  assert.match(buildStatusText(DATA, settings({ showFolder: true })), /ccstatus/);
});

const NOT_INSTALLED: StatusData = { ...DATA, claudeCodeInstalled: false };

// The path taken when Claude Code is absent once kept the folder unconditional
// so the item would never look empty. A setting that says "hide the folder" and
// then does not hide the folder reads as a bug, so the exception is gone.
test('the folder stays hidden even when Claude Code is not installed', () => {
  assert.doesNotMatch(buildStatusText(NOT_INSTALLED, settings()), /ccstatus/);
});

// Without Claude Code there is no context, no limits, and no session to report;
// every reading on the line would be invented. The item falls back to naming
// itself, which is also what keeps it visible and clickable.
test('an uninstalled Claude Code reports nothing it cannot measure', () => {
  const text = buildStatusText(NOT_INSTALLED, settings({ showFolder: true }));

  assert.match(text, /Claude/);
  assert.doesNotMatch(text, /68%/);
  assert.doesNotMatch(text, /Session:/);
  assert.doesNotMatch(text, /136k/);
});

// VS Code ships an SCM status bar item that already shows the branch. Showing
// it again by default is the same duplication as the folder.
test('the branch is hidden unless asked for', () => {
  assert.doesNotMatch(buildStatusText(DATA, settings()), /main/);
});

test('the branch comes back when the setting asks for it', () => {
  assert.match(buildStatusText(DATA, settings({ showGitBranch: true })), /main/);
});

// The degenerate case the dropped exception was guarding against: everything
// off and nothing installed. Mild, and worth noticing — but the item still has
// to render something, or it becomes an unclickable blank in the status bar.
test('the item is never blank, whatever is switched off', () => {
  const allOff = settings({
    showModel: false, showContextBar: false, showRateLimits: false,
    showGitBranch: false, showSessionDuration: false, showFolder: false,
    showSubscription: false,
  });

  assert.notEqual(buildStatusText(NOT_INSTALLED, allOff).trim(), '');
  assert.notEqual(buildStatusText(DATA, allOff).trim(), '');
});

// Reads the shipped defaults rather than restating them, so the settings a user
// actually gets are what the test below renders. Restating them would let the
// manifest drift from the line this file claims it produces.
function shippedDefaults(): SegmentSettings {
  const props = manifest.contributes.configuration.properties as Record<string, { default: unknown }>;
  const value = (name: keyof SegmentSettings) => props[`claudeStatusline.${name}`]?.default;

  return Object.fromEntries(
    Object.keys(DEFAULTS).map(name => [name, value(name as keyof SegmentSettings)]),
  ) as unknown as SegmentSettings;
}

// The whole point of the change, stated as the line a new user sees: session
// state, and none of the workspace identity VS Code already displays.
test('the default status line is session state only', () => {
  const text = buildStatusText(DATA, shippedDefaults());

  assert.doesNotMatch(text, /ccstatus/);
  assert.doesNotMatch(text, /main/);

  assert.match(text, /Opus 5/);
  assert.match(text, /136k \/ 200k/);
  assert.match(text, /68%/);
  assert.match(text, /Session:12%/);
  assert.match(text, /Weekly:30%/);
});
