import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  progressBar,
  prettifyModelName,
  formatCountdown,
  formatDuration,
  colorThreshold,
} from './format';

const STYLES = ['solid', 'hatched', 'blocks', 'faint'] as const;
const WIDTHS = [5, 10, 15, 20];

// The bar sits inline in the status bar, so a bar that changes length as it
// fills would shift every segment to its right. Width is a hard guarantee.
test('a bar is exactly as wide as it was asked to be', () => {
  for (const style of STYLES) {
    for (const width of WIDTHS) {
      for (let pct = 0; pct <= 100; pct++) {
        const bar = progressBar(pct, width, style);
        assert.equal(
          [...bar].length,
          width,
          `${style} at width ${width}, ${pct}%: got ${JSON.stringify(bar)}`,
        );
      }
    }
  }
});

// The regression that motivated the rewrite: rounding to whole blocks made 95%
// indistinguishable from a genuinely full context window.
test('a bar below 100% is never rendered as completely full', () => {
  assert.notEqual(progressBar(95, 10, 'solid'), '██████████');

  for (const style of STYLES) {
    for (const width of WIDTHS) {
      const full = progressBar(100, width, style);
      for (let pct = 0; pct < 100; pct++) {
        assert.notEqual(
          progressBar(pct, width, style),
          full,
          `${style} at width ${width}, ${pct}% is indistinguishable from full`,
        );
      }
    }
  }
});

// The counterpart signal: a genuinely exhausted context window must be
// unmistakable, with no track glyph left anywhere in the bar.
test('100% renders completely full', () => {
  for (const style of STYLES) {
    for (const width of WIDTHS) {
      const bar = progressBar(100, width, style);
      const fill = style === 'hatched' ? '▓' : style === 'faint' ? '░' : '█';
      assert.equal(bar, fill.repeat(width), `${style} at width ${width}`);
    }
  }
});

// The worked examples from the issue, so the table stays a specification
// rather than an illustration.
test('the documented examples render exactly as specified', () => {
  assert.equal(progressBar(1, 10, 'solid'), '▏·········');
  assert.equal(progressBar(16, 10, 'solid'), '█▌········');
  assert.equal(progressBar(94, 10, 'solid'), '█████████▍');
  assert.equal(progressBar(1, 10, 'hatched'), '▓░░░░░░░░░');
  assert.equal(progressBar(94, 10, 'blocks'), '█████████░');
  assert.equal(progressBar(94, 10, 'faint'), '░░░░░░░░░·');
});

// A context window that has started filling should look like it has. Rounding
// 1% down to an empty bar hides the only thing the user is watching for.
test('any non-zero percentage renders at least one visible unit', () => {
  for (const style of STYLES) {
    for (const width of WIDTHS) {
      for (let pct = 1; pct <= 100; pct++) {
        const bar = progressBar(pct, width, style);
        assert.notEqual(
          bar,
          progressBar(0, width, style),
          `${style} at width ${width}, ${pct}% is indistinguishable from empty`,
        );
      }
    }
  }
});

test('an empty bar is rendered entirely as track', () => {
  assert.equal(progressBar(0, 10, 'solid'), '··········');
});

// contextPct is derived from parsed transcript data, so the bar has to survive
// a figure that is missing, malformed, or out of range without breaking the
// status bar it sits in.
test('an unusable percentage renders as an empty bar', () => {
  assert.equal(progressBar(NaN, 10, 'solid'), '··········');
});

test('a percentage outside 0-100 is clamped to the ends', () => {
  assert.equal(progressBar(-20, 10, 'solid'), '··········');
  assert.equal(progressBar(140, 10, 'solid'), '██████████');
});

test('a fractional percentage renders at sub-block resolution', () => {
  // 12.5% of 80 eighths is 10 eighths: one full character and a quarter.
  assert.equal(progressBar(12.5, 10, 'solid'), '█▎········');
  assert.equal(progressBar(6.25, 10, 'solid'), '▋·········');
});

// The whole-character styles trade resolution for appearance. They are distinct
// glyph vocabularies, not variations on the default.
test('each style draws with its own fill and track glyphs', () => {
  assert.equal(progressBar(68, 10, 'hatched'), '▓▓▓▓▓▓░░░░');
  assert.equal(progressBar(68, 10, 'blocks'), '██████░░░░');
  assert.equal(progressBar(68, 10, 'faint'), '░░░░░░····');
});

test('only the solid style renders partial characters', () => {
  assert.equal(progressBar(68, 10, 'solid'), '██████▊···');
});

// How much of a character each glyph represents, for measuring what the bar
// actually claims. The eighth-blocks are what buy `solid` its resolution.
const FILL_WEIGHT: Record<string, number> = {
  '█': 1, '▓': 1, '░': 1,
  '▉': 7 / 8, '▊': 6 / 8, '▋': 5 / 8, '▌': 4 / 8, '▍': 3 / 8, '▎': 2 / 8, '▏': 1 / 8,
  '·': 0,
};

// `faint` fills with '░', which is a track glyph in other styles; measure each
// bar against its own style's vocabulary rather than a global notion of "fill".
function measureFill(bar: string, style: (typeof STYLES)[number]): number {
  const track = style === 'solid' || style === 'faint' ? '·' : '░';
  return [...bar]
    .map((ch) => (ch === track ? 0 : FILL_WEIGHT[ch] ?? 0))
    .reduce((a, b) => a + b, 0);
}

// The point of the rewrite: the bar must agree with the percentage beside it.
// A bar of N units can be off by at most one unit, since fill truncates to
// whole units. `solid` has 8x the units, hence 8x the precision.
test('rendered fill stays within each style\'s stated error bound', () => {
  for (const style of STYLES) {
    for (const width of WIDTHS) {
      const unitPct = 100 / (width * (style === 'solid' ? 8 : 1));
      for (let pct = 1; pct < 100; pct++) {
        const shown = (measureFill(progressBar(pct, width, style), style) / width) * 100;
        assert.ok(
          Math.abs(shown - pct) <= unitPct,
          `${style} at width ${width}, ${pct}%: bar shows ${shown.toFixed(2)}%`,
        );
      }
    }
  }
});

// `solid` is the style that delivers the accuracy fix; the whole-character
// styles are aesthetic choices that knowingly give up resolution. At width 10
// that is a full order of magnitude apart, which is the reason `solid` is the
// default. Bounds are one unit, the cost of truncating rather than rounding.
test('solid resolves eight times finer than the whole-character styles', () => {
  const worstError = (style: (typeof STYLES)[number]) => {
    let worst = 0;
    for (let pct = 1; pct < 100; pct++) {
      const shown = (measureFill(progressBar(pct, 10, style), style) / 10) * 100;
      worst = Math.max(worst, Math.abs(shown - pct));
    }
    return worst;
  };
  assert.equal(worstError('solid'), 1);
  for (const style of ['hatched', 'blocks', 'faint'] as const) {
    // 9%, not 10%: the worst case is 1%, where the low-end clamp forces a whole
    // block. Above that, truncation alone bounds the error at one unit.
    assert.equal(worstError(style), 9);
  }
});

test('bar fills in proportion to the percentage used', () => {
  assert.equal(progressBar(50, 10), '█████·····');
});

test('a raw model id renders as a human-readable name', () => {
  assert.equal(prettifyModelName('claude-sonnet-4-6-20250219'), 'Sonnet 4.6');
});

test('the long-context suffix is dropped from the model name', () => {
  assert.equal(prettifyModelName('claude-sonnet-4-6[1m]'), 'Sonnet 4.6');
});

test('an unknown model falls back to a generic name', () => {
  assert.equal(prettifyModelName(''), 'Claude');
});

test('a future reset time renders as the time remaining', () => {
  // Half a second of slack: the countdown floors to whole minutes, so a target
  // exactly 90m out would race the clock and render as "1h 29m".
  const in90Min = new Date(Date.now() + 90 * 60_000 + 500).toISOString();
  assert.equal(formatCountdown(in90Min), '1h 30m');
});

// The seven-day window puts resets days away. Hours alone stop being readable
// there, so the scale gains a unit rather than counting up to "76h".
test('a reset more than a day away renders in days and hours', () => {
  const in3d4h = new Date(Date.now() + (3 * 24 + 4) * 3_600_000 + 1_000).toISOString();
  assert.equal(formatCountdown(in3d4h), '3d 4h');
});

// A whole number of days drops the hours entirely, the same way a whole number
// of hours already drops the minutes.
test('a reset a whole number of days away renders in days alone', () => {
  const in4d = new Date(Date.now() + 4 * 24 * 3_600_000 + 1_000).toISOString();
  assert.equal(formatCountdown(in4d), '4d');
});

// The scale changes at a day and only there: just under it, hours still carry
// the meaning.
test('a reset just under a day away still renders in hours', () => {
  const in23h59m = new Date(Date.now() + (23 * 60 + 59) * 60_000 + 1_000).toISOString();
  assert.equal(formatCountdown(in23h59m), '23h 59m');
});

test('a reset time that has already passed renders as nothing', () => {
  const anHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  assert.equal(formatCountdown(anHourAgo), '');
});

test('an absent reset time renders as nothing', () => {
  assert.equal(formatCountdown(null), '');
});

test('a session under an hour renders in minutes alone', () => {
  assert.equal(formatDuration(45), '45m');
});

test('a session over an hour renders in hours and minutes', () => {
  assert.equal(formatDuration(86), '1h 26m');
});

test('low usage carries no warning indicator', () => {
  assert.equal(colorThreshold(20), '');
});

test('usage past the halfway mark is flagged as a warning', () => {
  assert.equal(colorThreshold(50), '$(warning)');
});

test('usage approaching the limit is flagged as an error', () => {
  assert.equal(colorThreshold(80), '$(error)');
});
