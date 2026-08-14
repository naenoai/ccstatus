import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveRateLimits,
  rateLimitSegments,
  rememberRateLimits,
  shouldAttemptFetch,
} from './ratelimits';

// Reset times are absolute instants, so any expectation about a countdown has
// to be written relative to now. The extra second absorbs the clock advancing
// between constructing the input and rendering it.
const inMinutes = (mins: number) => new Date(Date.now() + mins * 60_000 + 1_000).toISOString();

const BOTH_COUNTDOWNS = { showSessionReset: true, showWeeklyReset: true };

// The bug this module exists to fix: the cache reports zeroes when the CLI
// payload carried no rate limits at all, and the extension rendered them as a
// measured 0%. A real 0% always arrives with a reset time, so the timestamp is
// what separates "you have used none" from "I do not know".
test('a zero with no reset time is unknown, not a measured zero', () => {
  const limits = resolveRateLimits({
    cache: { r5: 0, r7: 0, r5_resets_at: '', r7_resets_at: '' },
    oauth: null,
  });

  assert.equal(limits.session, null);
  assert.equal(limits.weekly, null);
});

// The shape the generated script actually writes when the CLI payload carries
// no rate limits: explicit nulls rather than zeroes.
test('nulls written by the statusline script are unknown', () => {
  const limits = resolveRateLimits({
    cache: { r5: null, r7: null, r5_resets_at: '', r7_resets_at: '' },
    oauth: null,
  });

  assert.equal(limits.session, null);
  assert.equal(limits.weekly, null);
});

// The converse, and the reason the heuristic is safe: a user who genuinely has
// used none of their quota must still see 0%, not an empty status bar.
test('a zero accompanied by a reset time is a measured zero', () => {
  const limits = resolveRateLimits({
    cache: {
      r5: 0, r7: 0,
      r5_resets_at: '2026-08-15T02:00:00Z',
      r7_resets_at: '2026-08-20T00:00:00Z',
    },
    oauth: null,
  });

  assert.deepEqual(limits.session, { pct: 0, resetsAt: '2026-08-15T02:00:00Z' });
  assert.deepEqual(limits.weekly, { pct: 0, resetsAt: '2026-08-20T00:00:00Z' });
});

// The two windows are separate measurements and are reported separately: a
// known session figure is worth showing even when the weekly one is missing.
test('one window can be known while the other is not', () => {
  const limits = resolveRateLimits({
    cache: { r5: 42, r7: 0, r5_resets_at: '2026-08-15T02:00:00Z', r7_resets_at: '' },
    oauth: null,
  });

  assert.deepEqual(limits.session, { pct: 42, resetsAt: '2026-08-15T02:00:00Z' });
  assert.equal(limits.weekly, null);
});

// The OAuth API is the source that works when the cache never got written —
// the case the credential fix (#4) was meant to unlock.
test('the OAuth API supplies limits when the cache has none', () => {
  const limits = resolveRateLimits({
    cache: null,
    oauth: {
      five_hour: { utilization: 37.4, resets_at: '2026-08-15T02:00:00Z' },
      seven_day: { utilization: 12.6, resets_at: '2026-08-20T00:00:00Z' },
    },
  });

  // Utilisation arrives fractional; the status bar renders whole percents.
  assert.deepEqual(limits.session, { pct: 37, resetsAt: '2026-08-15T02:00:00Z' });
  assert.deepEqual(limits.weekly, { pct: 13, resetsAt: '2026-08-20T00:00:00Z' });
});

// Fallback is per window, not all-or-nothing: a cache that measured only the
// session window should not suppress a weekly figure the API does have.
test('the OAuth API fills in only the windows the cache left unknown', () => {
  const limits = resolveRateLimits({
    cache: { r5: 42, r7: 0, r5_resets_at: '2026-08-15T02:00:00Z', r7_resets_at: '' },
    oauth: {
      five_hour: { utilization: 99, resets_at: '2026-08-15T09:00:00Z' },
      seven_day: { utilization: 13, resets_at: '2026-08-20T00:00:00Z' },
    },
  });

  // The cache measured the session window, so it wins.
  assert.deepEqual(limits.session, { pct: 42, resetsAt: '2026-08-15T02:00:00Z' });
  assert.deepEqual(limits.weekly, { pct: 13, resetsAt: '2026-08-20T00:00:00Z' });
});

// Nothing anywhere is the ordinary state on a machine that has never run the
// CLI and has no credentials. It must resolve, not throw.
test('with no sources at all, nothing is known', () => {
  const limits = resolveRateLimits({ cache: null, oauth: null });

  assert.equal(limits.session, null);
  assert.equal(limits.weekly, null);
});

// An unknown window occupies no width at all. A placeholder would sit there
// permanently on setups where the data never arrives.
test('unknown windows contribute no segments to the status bar', () => {
  assert.deepEqual(rateLimitSegments({ session: null, weekly: null }, false), []);
});

// Two spaces rather than a colon: the status bar is a dense line of segments,
// and the gap separates the label from its figure without adding punctuation
// to compete with the separators between segments.
test('a known window renders its label and percentage', () => {
  const segments = rateLimitSegments({
    session: { pct: 42, resetsAt: null },
    weekly: { pct: 13, resetsAt: null },
  }, false);

  assert.deepEqual(segments, ['Session  42%', 'Weekly  13%']);
});

// Only the known window appears; the unknown one leaves no trace, not even a
// separator or an empty label.
test('a half-known pair renders only the window that is known', () => {
  const segments = rateLimitSegments({
    session: { pct: 42, resetsAt: null },
    weekly: null,
  }, false);

  assert.deepEqual(segments, ['Session  42%']);
});

// Threshold colouring is a claim about measured usage. An omitted window never
// carries an icon, because there is no measurement to warn about.
test('threshold icons appear on measured usage', () => {
  const segments = rateLimitSegments({
    session: { pct: 85, resetsAt: null },
    weekly: { pct: 60, resetsAt: null },
  }, false);

  assert.deepEqual(segments, ['$(error)Session  85%', '$(warning)Weekly  60%']);
});

// The regression guard for the original bug: the all-zeroes cache used to
// render two segments; now it renders none, and so cannot be coloured at all.
test('an unavailable window is never coloured', () => {
  const limits = resolveRateLimits({
    cache: { r5: 0, r7: 0, r5_resets_at: '', r7_resets_at: '' },
    oauth: null,
  });

  for (const segment of rateLimitSegments(limits, false)) {
    assert.ok(!segment.includes('$('), `unavailable window was coloured: ${segment}`);
  }
  assert.deepEqual(rateLimitSegments(limits, false), []);
});

// A percentage means something different ten minutes from a reset than three
// hours from one. The countdown follows its own percentage so the pairing is
// unambiguous with two of them on the line.
test('the session countdown renders immediately after its percentage', () => {
  const segments = rateLimitSegments({
    session: { pct: 62, resetsAt: inMinutes(134) },
    weekly: null,
  }, false, BOTH_COUNTDOWNS);

  assert.deepEqual(segments, ['$(warning)Session  62%', '↻ 2h 14m']);
});

// Both countdowns on one line: each sits beside the percentage it belongs to,
// never pooled at the end where the reader would have to guess the pairing.
test('each countdown renders beside its own percentage', () => {
  const segments = rateLimitSegments({
    session: { pct: 62, resetsAt: inMinutes(134) },
    weekly: { pct: 31, resetsAt: inMinutes(3 * 24 * 60 + 4 * 60) },
  }, false, BOTH_COUNTDOWNS);

  assert.deepEqual(segments, [
    '$(warning)Session  62%', '↻ 2h 14m',
    'Weekly  31%', '↻ 3d 4h',
  ]);
});

// A measured percentage with no reset time is still worth showing; an empty
// countdown beside it is not. The same availability rule as the percentages,
// applied to each countdown on its own.
test('a window with no reset time renders its percentage but no countdown', () => {
  const segments = rateLimitSegments({
    session: { pct: 62, resetsAt: inMinutes(134) },
    weekly: { pct: 31, resetsAt: null },
  }, false, BOTH_COUNTDOWNS);

  assert.deepEqual(segments, ['$(warning)Session  62%', '↻ 2h 14m', 'Weekly  31%']);
});

// A reset time in the past is spent, not a countdown of zero. It renders the
// same as no reset time at all.
test('a reset time already past renders no countdown', () => {
  const segments = rateLimitSegments({
    session: { pct: 62, resetsAt: inMinutes(-30) },
    weekly: null,
  }, false, BOTH_COUNTDOWNS);

  assert.deepEqual(segments, ['$(warning)Session  62%']);
});

// The two countdowns are separately controlled, so neither setting may reach
// the other's segment, and neither may suppress a percentage.
test('each countdown is suppressed only by its own setting', () => {
  const limits = {
    session: { pct: 62, resetsAt: inMinutes(134) },
    weekly: { pct: 31, resetsAt: inMinutes(3 * 24 * 60 + 4 * 60) },
  };

  assert.deepEqual(
    rateLimitSegments(limits, false, { showSessionReset: true, showWeeklyReset: false }),
    ['$(warning)Session  62%', '↻ 2h 14m', 'Weekly  31%'],
  );

  assert.deepEqual(
    rateLimitSegments(limits, false, { showSessionReset: false, showWeeklyReset: true }),
    ['$(warning)Session  62%', 'Weekly  31%', '↻ 3d 4h'],
  );

  assert.deepEqual(
    rateLimitSegments(limits, false, { showSessionReset: false, showWeeklyReset: false }),
    ['$(warning)Session  62%', 'Weekly  31%'],
  );
});

// Staleness marks a measured value as ageing; it is orthogonal to whether the
// value is known at all.
test('stale measurements are marked but still shown', () => {
  const segments = rateLimitSegments({
    session: { pct: 42, resetsAt: null },
    weekly: null,
  }, true);

  assert.deepEqual(segments, ['Session  ~42%']);
});

// Staleness is a claim about the percentage, which was measured at some past
// moment. The reset time is an absolute instant, so its countdown is exactly
// as accurate in a stale reading as in a fresh one and carries no mark.
test('a countdown from a stale reading is unmarked and still counts down', () => {
  const segments = rateLimitSegments({
    session: { pct: 42, resetsAt: inMinutes(134) },
    weekly: null,
  }, true, BOTH_COUNTDOWNS);

  assert.deepEqual(segments, ['Session  ~42%', '↻ 2h 14m']);
});

// The bug behind #27: while the editor sits idle the statusline script never
// runs, so the cache ages out and the OAuth API becomes the only source. A
// single failed call used to resolve to nothing and empty the status bar, with
// the next refresh five seconds later filling it back in — a percentage that
// blinks in and out while the user is not even typing.
test('a resolution that knows nothing falls back to the last known reading', () => {
  const known = resolveRateLimits({
    cache: { r5: 42, r7: 13, r5_resets_at: '2026-08-15T02:00:00Z', r7_resets_at: '2026-08-20T00:00:00Z' },
    oauth: null,
  });

  const blank = resolveRateLimits({ cache: null, oauth: null });
  const held = rememberRateLimits(blank, { limits: known, at: Date.now() });

  assert.deepEqual(held.limits.session, { pct: 42, resetsAt: '2026-08-15T02:00:00Z' });
  assert.deepEqual(held.limits.weekly, { pct: 13, resetsAt: '2026-08-20T00:00:00Z' });
  // The reading is a remembered one, so it must not pass for a fresh figure.
  assert.equal(held.stale, true);
});

// A remembered reading is worth showing for as long as it is plausibly still
// true, and no longer. A day matches the point at which the on-disk cache is
// discarded outright, so both sources forget on the same schedule.
test('a remembered reading older than a day is forgotten', () => {
  const known = resolveRateLimits({
    cache: { r5: 42, r7: 13, r5_resets_at: '2026-08-15T02:00:00Z', r7_resets_at: '2026-08-20T00:00:00Z' },
    oauth: null,
  });

  const aDayAndAnHourAgo = Date.now() - (25 * 60 * 60 * 1000);
  const held = rememberRateLimits(
    resolveRateLimits({ cache: null, oauth: null }),
    { limits: known, at: aDayAndAnHourAgo },
  );

  assert.equal(held.limits.session, null);
  assert.equal(held.limits.weekly, null);
  assert.deepEqual(rateLimitSegments(held.limits, held.stale), []);
});

// Falling back is for the case where nothing at all resolved. A refresh that
// measured one window has genuinely new information, and the remembered
// reading must not be allowed to overwrite it with an older figure.
test('a fresh partial reading is preferred over a fuller remembered one', () => {
  const known = resolveRateLimits({
    cache: { r5: 42, r7: 13, r5_resets_at: '2026-08-15T02:00:00Z', r7_resets_at: '2026-08-20T00:00:00Z' },
    oauth: null,
  });

  const partial = resolveRateLimits({
    cache: { r5: 55, r7: null, r5_resets_at: '2026-08-15T06:00:00Z', r7_resets_at: '' },
    oauth: null,
  });

  const held = rememberRateLimits(partial, { limits: known, at: Date.now() });

  assert.deepEqual(held.limits.session, { pct: 55, resetsAt: '2026-08-15T06:00:00Z' });
  // The weekly window is unknown right now, and says so rather than borrowing
  // the remembered 13%.
  assert.equal(held.limits.weekly, null);
  assert.equal(held.stale, false);
});

// The other half of #27: the status bar refreshes every few seconds, and once
// the cache goes stale every one of those refreshes reached for the API. A
// failure was recorded nowhere, so a network blip produced a retry on every
// tick — each one able to fail and blank the line again.
test('a failed fetch is not retried on the very next refresh', () => {
  const justFailed = { lastAttempt: Date.now(), succeeded: false };

  assert.equal(shouldAttemptFetch(justFailed, Date.now() + 5_000), false);
});

// The pause has to end. An outage that resolves itself must not leave the
// status bar permanently empty because the extension stopped asking.
test('the API is tried again once the pause has elapsed', () => {
  const failedLongAgo = { lastAttempt: Date.now(), succeeded: false };

  assert.equal(shouldAttemptFetch(failedLongAgo, Date.now() + 61_000), true);
});

// Nothing has been tried yet on a freshly started editor, which is the first
// moment the status bar needs a figure.
test('the first fetch of a session always goes ahead', () => {
  assert.equal(shouldAttemptFetch(null), true);
});
