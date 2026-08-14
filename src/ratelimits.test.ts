import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveRateLimits, rateLimitSegments } from './ratelimits';

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

test('a known window renders its label and percentage', () => {
  const segments = rateLimitSegments({
    session: { pct: 42, resetsAt: null },
    weekly: { pct: 13, resetsAt: null },
  }, false);

  assert.deepEqual(segments, ['Session:42%', 'Weekly:13%']);
});

// Only the known window appears; the unknown one leaves no trace, not even a
// separator or an empty label.
test('a half-known pair renders only the window that is known', () => {
  const segments = rateLimitSegments({
    session: { pct: 42, resetsAt: null },
    weekly: null,
  }, false);

  assert.deepEqual(segments, ['Session:42%']);
});

// Threshold colouring is a claim about measured usage. An omitted window never
// carries an icon, because there is no measurement to warn about.
test('threshold icons appear on measured usage', () => {
  const segments = rateLimitSegments({
    session: { pct: 85, resetsAt: null },
    weekly: { pct: 60, resetsAt: null },
  }, false);

  assert.deepEqual(segments, ['$(error)Session:85%', '$(warning)Weekly:60%']);
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

// Staleness marks a measured value as ageing; it is orthogonal to whether the
// value is known at all.
test('stale measurements are marked but still shown', () => {
  const segments = rateLimitSegments({
    session: { pct: 42, resetsAt: null },
    weekly: null,
  }, true);

  assert.deepEqual(segments, ['Session:~42%']);
});
