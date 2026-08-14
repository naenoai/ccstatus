# CC Status

> Claude Code context, model, session usage, weekly limit, git branch — right in your VS Code status bar. Zero setup required.

```
✨ Sonnet 4.6  │  ██········ 13%  │  Session:6%  │  Weekly:19%  │  ↻ 1h 26m  │  ⎇ main  │  📁 my-project  │  ⊙ Team
```

---

## What it shows

| Segment | Description |
|---|---|
| `✨ Sonnet 4.6` | Current Claude model |
| `██········ 13%` | Context window usage (green → yellow → red) |
| `Session:6%` | 5-hour rolling session usage |
| `Weekly:19%` | 7-day weekly usage |
| `↻ 1h 26m` | Time until session limit resets |
| `⎇ main` | Git branch of workspace |
| `📁 my-project` | Current workspace folder |
| `⊙ Team` | Subscription plan |

Colors follow green → yellow → red at 50% and 80% thresholds.

---

## Requirements

- VS Code 1.85+
- [Claude Code CLI](https://claude.ai/install) (optional — git branch + folder always work without it)

---

## Setup

**Install the extension. That's it.**

On first activation, the extension:
1. Writes `~/.claude/statusline.sh` (Claude Code's statusline hook)
2. Registers it in `~/.claude/settings.json`
3. Starts reading live data on your next Claude Code prompt

No manual configuration needed.

### Without Claude Code CLI

The extension still shows:
```
✨ Claude  │  ⎇ main  │  📁 my-project
```
Hover the status bar item for a link to install Claude Code CLI and unlock all segments.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeStatusline.refreshInterval` | `5` | Refresh every N seconds (2–60) |
| `claudeStatusline.showModel` | `true` | Show model name |
| `claudeStatusline.showContextBar` | `true` | Show context window bar |
| `claudeStatusline.showRateLimits` | `true` | Show Session/Weekly usage |
| `claudeStatusline.showGitBranch` | `true` | Show git branch |
| `claudeStatusline.showSessionDuration` | `true` | Show session duration |
| `claudeStatusline.showSubscription` | `true` | Show plan badge |
| `claudeStatusline.alignment` | `"left"` | `"left"` or `"right"` |
| `claudeStatusline.priority` | `100` | Status bar priority |

Settings keys keep the `claudeStatusline.*` prefix from upstream so that existing
configuration keeps working across the rename. In the settings UI they appear under
**CC Status**.

---

## Commands

- **CC Status: Refresh Now** — Force refresh
- **CC Status: Show Details** — Quick detail popup
- **CC Status: Run Diagnostics** — Debug output channel
- **CC Status: Open Settings** — Jump to settings

---

## How it works

The extension writes a `statusline.sh` script that Claude Code CLI calls on every prompt, piping live JSON (model, context %, rate limits, session info). The script renders the terminal statusline and simultaneously writes `~/.claude/rate-cache.json`. The VS Code extension reads this cache file every 5 seconds for live data.

When the cache is stale (>2 min since last CLI prompt), values show with a `~` prefix. When a new Claude Code session is detected (transcript newer than cache), context resets to 0%.

---

## Development

```bash
npm install
npm run compile     # build to out/
npm test            # unit tests — plain Node, no VS Code host required
npm run typecheck   # type-check source and tests
npm run package     # build a .vsix
```

Tests run under Node's built-in test runner via `tsx`, so they need no editor
instance. Pure rendering logic lives in `src/format.ts`, which deliberately does
not import `vscode` — that is what keeps it directly testable.

---

## Credits

A fork of [claude-statusline](https://github.com/Brainmetrix/claude-statusline) by
[Vivek Singh Rajput](https://github.com/Brainmetrix), extended with an accurate
context bar, working rate limits, and configurable status line segments.

---

## License

MIT. Original work © [Vivek Singh Rajput](https://github.com/Brainmetrix); see [LICENSE](LICENSE).
