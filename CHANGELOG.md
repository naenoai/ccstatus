# Changelog

## [Unreleased]

### Added

- **The reasoning effort level now appears beside the model name**, as `Opus 5 high`. Two sessions on the same model behave differently at high and medium effort, and the model name alone could not tell them apart. Effort is read from the session transcript, which is the only source that reports it — Claude Code's statusline payload does not — so it is shown only when a transcript recorded one, and older sessions that predate the field simply keep the plain model name. Controlled by `claudeStatusline.showEffort`, on by default, and it follows `showModel`: hiding the model hides the effort with it.

### Changed

- **The context bar has a new default style, `minimal`**, drawing its unfilled remainder as a thin rule rather than shaded cells: `███───────` rather than `███░░░░░░░`. `░` is a stippled glyph that the status bar's proportional UI font renders with its own cell borders, so the track read as a strip of separate squares competing with the fill instead of as one bar behind it. The previous `solid` default had a related problem in the same font — its partial-block glyphs (`▎`, `▌`, `▉`) carry no guaranteed advance width and commonly draw at a full cell, making the bar overstate progress against the percentage beside it. `minimal` gives up sub-character resolution to keep the bar and its number in agreement. All four previous styles remain selectable through `claudeStatusline.barStyle`, so an explicit setting is untouched.
- **Reset countdowns no longer have a separator to their left**, reading `Weekly  19%  ↻ 2d 2h` rather than `Weekly  19%  │  ↻ 2d 2h`. A countdown only ever qualifies the percentage beside it, and the separator announced it as a reading in its own right. The pairing itself is unchanged: each countdown still sits with the window it belongs to, and `showSessionReset` and `showWeeklyReset` still control them independently.

## [1.2.1] — 2026-08-14

### Fixed

- **Rate limits no longer blink in and out of the status bar while the editor sits idle.** With no input to Claude the statusline script never runs, so the rate cache ages out and the usage API becomes the only source — and a single failed call emptied the line until the next refresh a few seconds later put it back. The last known reading is now held across a failed refresh, marked stale with `~`, and forgotten after a day. A failed call is also waited out for a minute rather than retried on every refresh, so a brief outage costs a handful of calls instead of one per tick. (#27)

### Changed

- **Rate limit labels are separated from their figures by two spaces** rather than a colon: `Session  42%`. The status bar already separates its segments, and the colon competed with that. The terminal statusline script and the details popup are unchanged.

## [1.2.0] — 2026-08-14

The status line becomes accurate about context, honest about rate limits, and
quiet about things VS Code already tells you.

### Breaking

- **The git branch is now hidden by default.** `showGitBranch` defaults to `false`, down from `true` — VS Code ships an SCM status bar item that already shows it. Set `claudeStatusline.showGitBranch` back to `true` to restore it. (#9)
- **The workspace folder is now hidden by default**, for the same reason: VS Code shows it in the title bar, Explorer, and window title. It was previously unconditional with no way to turn it off; it is now controlled by the new `showFolder` setting, defaulting to `false`. (#9)

Together these make the default status line session state — model, tokens, context bar, and rate limits — and nothing the editor chrome already displays.

### Added

- **Absolute token counts** beside the context bar, so headroom reads in the units people actually think in: `136k / 200k` rather than a percentage of an invisible denominator. Counts below a thousand keep a decimal, so a fresh session reads `0.4k` rather than a broken-looking `0k`. (#22)
- **Four bar widths and four bar styles** — `barWidth` (`small`/`medium`/`large`/`xl`) and `barStyle` (`solid`/`hatched`/`blocks`/`faint`). `medium` and `solid` are the defaults, matching the previous appearance and the highest accuracy. (#22)
- **Reset countdowns for both rate limit windows**, each rendered directly after the percentage it belongs to, so the pairing is unambiguous: `Session:62% ↻ 2h 14m`. Controlled independently by `showSessionReset` and `showWeeklyReset`. (#20)
- **`contextWindowSize` setting** to override the context window denominator, for third-party APIs whose window size cannot be inferred from the model name. Accepts `200k`, `1M`, or a plain token count. (#21)
- **`showFolder` setting**, honoured both on the main status line and on the "Claude Code not installed" fallback path. (#9)
- **macOS Keychain credential reading**, from the `Claude Code-credentials` service where Claude Code actually stores them. (#18)

### Fixed

- **The context percentage was wrong on every non-200K model.** The denominator was hardcoded to 200,000, inflating usage by up to 5× on 1M-context models — the extension showed ~30% where `/context` showed ~6%. The window is now resolved from the model in use. (#21)
- **The progress bar contradicted its own percentage.** Ten whole blocks meant ±5% error, and it saturated: 95% rendered as completely full, so the range where precision matters most was the range where the bar stopped distinguishing anything. Under 5% rendered as completely empty. The bar now uses partial block characters for eight sub-steps per character, reducing maximum error to ±0.6% at the default width. A full bar now means 100% and nothing else, and any non-zero usage draws something visible. (#15)
- **Session and weekly limits always showed 0%.** Both data sources were dead — cached values were zeroes because the payload omitted rate limits, and the OAuth fallback looked for credentials in a file that does not exist on macOS. Rate limits now work on a standard macOS install with no manual setup. (#18)
- **0% no longer stands in for "unknown".** Where usage data is genuinely unavailable, the segments are omitted rather than shown as zero — an absent segment means unknown, a present one means measured. The tooltip says so in words, since the status bar can only communicate it by absence. (#19)
- **The token count, the bar, and the percentage can no longer disagree** with one another on screen. (#22)

### Changed

- Fork re-identified as **CC Status**, with its own icon and branding. Settings keys keep the `claudeStatusline.*` prefix so existing configuration keeps working. (#13, #23)
- Unit test runner added; the rendering, rate limit, credential, and status line assembly modules are covered by 75 tests. (#13)

---

## [1.1.0] — 2026-04-19

### Added
- **OAuth API Support**: Direct API integration with `api.anthropic.com/api/oauth/usage` for fetching fresh rate limits
- **Three-Tier Data Pipeline**: Prioritized data sources (rate-cache → OAuth API → stale cache) for improved reliability
- **OAuth Credentials Support**: Reads OAuth tokens from `~/.claude/.credentials.json` for API authentication
- **API Caching**: 60-second in-memory cache for OAuth API requests to minimize redundant calls
- **Enhanced Session Detection**: Improved logic to detect new Claude Code sessions based on transcript timestamps
- **Better Context Estimation**: More accurate context percentage calculation from cumulative token usage

### Improved
- **Data Source Fallback Chain**: Gracefully falls back from live cache to OAuth API to stale cache
- **Diagnostics Command**: Added OAuth API connectivity test to debug output
- **Error Handling**: Better error handling for missing or invalid credentials
- **Code Organization**: Refactored for better maintainability and performance

### Fixed
- **Model Extraction**: Enhanced `.model.id` fallback for edge cases where display_name is unavailable
- **Timestamp Handling**: Improved Unix timestamp parsing for countdown calculations
- **New Session Detection**: More accurate detection when transcript is created after last cache update

---

## [1.0.0] — 2026-04-18

### Added
- Status bar: model name, context window bar, session usage, weekly limit, reset countdown, git branch, folder, plan badge
- Automatic `~/.claude/statusline.sh` setup — no manual configuration required
- Live rate limits from Claude Code CLI payload via `~/.claude/rate-cache.json`
- Graceful degradation when Claude Code CLI is not installed
- Stale cache indicator (`~` prefix) when data is >2 minutes old
- New session detection — context resets to 0% when a new Claude Code terminal is opened
- Model name prettifier handles all variants: `claude-sonnet-4-6-20250514` → `Sonnet 4.6`
- Diagnostic command (`Claude Statusline: Run Diagnostics`) for troubleshooting
- Configurable segments, alignment, refresh interval
- Subscription plan badge (Pro / Team / Max)
