import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  progressBar,
  prettifyModelName,
  formatCountdown,
  formatDuration,
  colorThreshold,
} from './format';

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
