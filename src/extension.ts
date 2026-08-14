import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  colorThreshold,
  formatCountdown,
  formatDuration,
  formatTokenCount,
  formatWindowSize,
  prettifyModelName,
  resolveContextTokens,
  resolveContextWindow,
  progressBar,
} from './format';
import { KEYCHAIN_SERVICE, readCredentials, type OAuthCredentials } from './credentials';
import {
  resolveRateLimits,
  rememberRateLimits,
  shouldAttemptFetch,
  type FetchAttempt,
  type RememberedRateLimits,
  type ResolvedRateLimits,
} from './ratelimits';
import {
  buildStatusText,
  type SegmentSettings,
  type StatusData as RenderedStatusData,
} from './statusline';

// ─── Embedded statusline.sh ───────────────────────────────────────────────────
// Written to ~/.claude/statusline.sh on activation.
// Claude Code CLI calls it on every prompt with a JSON payload via stdin.
// Script renders the terminal statusline AND writes ~/.claude/rate-cache.json
// which the VS Code extension reads for live rate limit + context data.

// Cache-busting marker for the generated statusline script. It is written into
// the script header and compared against on activation: a mismatch rewrites
// ~/.claude/statusline.sh.
//
// Increment this with every new release. Users keep whatever script they
// already have until this number changes, so a release that forgets to bump it
// ships its script changes to nobody.
const CCSTATUS_VERSION = '3';

// Match the version as a whole token, so a v10 or v11 script is not mistaken
// for v1 merely because it starts with the same digits.
function isCurrentScript(contents: string): boolean {
  return new RegExp(`Claude Statusline v${CCSTATUS_VERSION}\\b`).test(contents);
}

const STATUSLINE_SCRIPT = (function() {
  const v = CCSTATUS_VERSION;
  const lines: string[] = [];
  const a = (s: string) => lines.push(s);

  a('#!/usr/bin/env bash');
  a('# Claude Statusline v' + v + ' — managed by Claude Statusline VS Code extension');
  a('# Do not edit manually; it will be overwritten on next activation.');
  a('payload=$(cat)');
  a('');
  a("reset='\\033[0m'; bold='\\033[1m'; dim='\\033[2m'");
  a("red='\\033[31m'; green='\\033[32m'; yellow='\\033[33m'");
  a("magenta='\\033[35m'; cyan='\\033[36m'");
  a('sep="${dim} │ ${reset}"');
  a('');
  a('# ── 1. Model ────────────────────────────────────────────────────────────────');
  a("model=$(echo \"$payload\" | jq -r '.model.display_name // .model.id // .model // \"Claude\"')");
  a('part_model="${magenta}${model}${reset}"');
  a('');
  a('# ── 2. Context window ───────────────────────────────────────────────────────');
  a("ctx_pct=$(echo \"$payload\" | jq -r '.context_window.used_percentage // 0')");
  a('ctx_int=$(printf "%.0f" "$ctx_pct")');
  a('filled=$(( ctx_int * 10 / 100 )); empty=$(( 10 - filled ))');
  a('bar=""');
  a('for ((i=0;i<filled;i++)); do bar+="█"; done');
  a('for ((i=0;i<empty;i++)); do bar+="░"; done');
  a('if   (( ctx_int >= 80 )); then ctx_color="$red"');
  a('elif (( ctx_int >= 50 )); then ctx_color="$yellow"');
  a('else                           ctx_color="$green"; fi');
  a('part_ctx="${ctx_color}${bar} ${ctx_int}%${reset}"');
  a('');
  a('# ── 3. Git branch ───────────────────────────────────────────────────────────');
  a("cwd=$(echo \"$payload\" | jq -r '.workspace.current_dir // .cwd // \"\"')");
  a('[[ -z "$cwd" ]] && cwd="$PWD"');
  a('part_git=""');
  a('if git -C "$cwd" rev-parse --is-inside-work-tree &>/dev/null; then');
  a('  branch=$(git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null \\');
  a('        || git -C "$cwd" rev-parse --short HEAD 2>/dev/null)');
  a('  part_git="${green} ${branch}${reset}"');
  a('fi');
  a('');
  a('# ── 4 & 5. Rate limits ──────────────────────────────────────────────────────');
  a('rate_color() {');
  a('  local p; p=$(printf "%.0f" "$1")');
  a('  if   (( p >= 80 )); then printf "%s" "$red"');
  a('  elif (( p >= 50 )); then printf "%s" "$yellow"');
  a('  else                     printf "%s" "$green"; fi');
  a('}');
  // Absent rate limits stay absent. Defaulting them to 0 made "no data" and
  // "no usage" indistinguishable downstream, which is the bug this fixes.
  a("r5=$(echo \"$payload\" | jq -r '.rate_limits.five_hour.used_percentage // empty')");
  a("r7=$(echo \"$payload\" | jq -r '.rate_limits.seven_day.used_percentage // empty')");
  a("r5_resets=$(echo \"$payload\" | jq -r 'if .rate_limits.five_hour.resets_at != null then .rate_limits.five_hour.resets_at else \"\" end')");
  a("r7_resets=$(echo \"$payload\" | jq -r 'if .rate_limits.seven_day.resets_at != null then .rate_limits.seven_day.resets_at else \"\" end')");
  // An absent window renders as nothing at all — no label, no colour. Absence
  // is how the line says "unknown"; a 0% would be a claim it cannot support.
  a('part_r5=""; part_r7=""');
  a('[[ -n "$r5" ]] && part_r5="$(rate_color $r5)Session:$(printf "%.0f" $r5)%${reset}"');
  a('[[ -n "$r7" ]] && part_r7="$(rate_color $r7)Weekly:$(printf "%.0f" $r7)%${reset}"');
  a('');
  a('# ── 6. Session duration ─────────────────────────────────────────────────────');
  a("transcript=$(echo \"$payload\" | jq -r '.transcript_path // \"\"')");
  a('part_dur=""');
  a('if [[ -n "$transcript" && -e "$transcript" ]]; then');
  a('  btime=$(stat -f %B "$transcript" 2>/dev/null || stat -c %Z "$transcript" 2>/dev/null)');
  a('  if [[ -n "$btime" && "$btime" != "0" ]]; then');
  a('    elapsed=$(( $(date +%s) - btime ))');
  a('    hrs=$(( elapsed / 3600 )); mins=$(( (elapsed % 3600) / 60 ))');
  a('    if (( hrs > 0 )); then');
  a('      dur="${hrs}h $(printf "%02d" $mins)m"');
  a('    else');
  a('      dur="${mins}m"');
  a('    fi');
  a('    part_dur="${dim}${dur}${reset}"');
  a('  fi');
  a('fi');
  a('');
  a('# ── 7. Folder ───────────────────────────────────────────────────────────────');
  a('folder=$(basename "$cwd")');
  a('part_folder="${bold}${cyan}${folder}${reset}"');
  a('');
  a('# ── Write rate-cache.json for VS Code extension ─────────────────────────────');
  // `null` rather than 0 for an absent window: the extension reads a missing
  // figure as unknown and omits the segment, instead of reporting a false 0%.
  a('[[ -n "$r5" ]] && r5_json=$(printf "%.0f" "$r5") || r5_json=null');
  a('[[ -n "$r7" ]] && r7_json=$(printf "%.0f" "$r7") || r7_json=null');
  a('jq -n \\');
  a('  --argjson r5    "$r5_json" \\');
  a('  --argjson r7    "$r7_json" \\');
  a('  --arg     r5at  "$r5_resets" \\');
  a('  --arg     r7at  "$r7_resets" \\');
  a('  --argjson ctx   "$ctx_int" \\');
  a('  --arg     model "$model" \\');
  a('  --arg     cwd   "$cwd" \\');
  a('  --argjson ts    "$(date +%s)" \\');
  a("  '{r5:$r5,r7:$r7,r5_resets_at:$r5at,r7_resets_at:$r7at,context_pct:$ctx,model:$model,cwd:$cwd,ts:$ts}' \\");
  a('  > "$HOME/.claude/rate-cache.json" 2>/dev/null || true');
  a('');
  a('# ── Assemble and print ──────────────────────────────────────────────────────');
  a('line="$part_model${sep}$part_ctx"');
  a('[[ -n "$part_git" ]] && line+="${sep}$part_git"');
  a('[[ -n "$part_r5" ]] && line+="${sep}$part_r5"');
  a('[[ -n "$part_r7" ]] && line+="${sep}$part_r7"');
  a('[[ -n "$part_dur" ]] && line+="${sep}$part_dur"');
  a('line+="${sep}$part_folder"');
  a('printf "%b\\n" "$line"');

  return lines.join('\n');
})();

// ─── Paths ────────────────────────────────────────────────────────────────────

const CLAUDE_DIR        = path.join(os.homedir(), '.claude');
const STATUSLINE_PATH   = path.join(CLAUDE_DIR, 'statusline.sh');
const SETTINGS_PATH     = path.join(CLAUDE_DIR, 'settings.json');
const RATE_CACHE_PATH   = path.join(CLAUDE_DIR, 'rate-cache.json');
const CREDENTIALS_PATH  = path.join(CLAUDE_DIR, '.credentials.json');

// ─── Types ────────────────────────────────────────────────────────────────────

interface RateCache {
  r5: number; r7: number;
  r5_resets_at: string; r7_resets_at: string;
  context_pct: number; model: string; cwd: string; ts: number;
}

interface CacheResult { data: RateCache; stale: boolean; }

// Everything the status bar renders, plus the fields only the tooltip and the
// details popup need. Extending the rendered shape keeps the two from drifting.
interface StatusData extends RenderedStatusData {
  rawModel: string;
  cwd: string;
  source: string;
  rateLimitsAvailable: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function exec(cmd: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    cp.exec(cmd, { timeout: timeoutMs }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
}

function which(bin: string): string {
  try { return cp.execSync(`which ${bin} 2>/dev/null`, { timeout: 1000 }).toString().trim(); }
  catch { return ''; }
}

// ─── Setup ────────────────────────────────────────────────────────────────────

function ensureStatuslineScript(): void {
  const claudeCliExists = fs.existsSync(CLAUDE_DIR) || !!which('claude');
  if (!claudeCliExists) { return; }
  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    let needsWrite = true;
    if (fs.existsSync(STATUSLINE_PATH)) {
      const existing = fs.readFileSync(STATUSLINE_PATH, 'utf8');
      if (isCurrentScript(existing)) { needsWrite = false; }
    }
    if (needsWrite) { fs.writeFileSync(STATUSLINE_PATH, STATUSLINE_SCRIPT, { mode: 0o755 }); }

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(SETTINGS_PATH)) {
      try { settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { /* start fresh */ }
    }
    const expected = { type: 'command', command: `bash ${STATUSLINE_PATH}` };
    const current = settings.statusLine as typeof expected | undefined;
    if (!current || current.command !== expected.command) {
      settings.statusLine = expected;
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    }
  } catch (e) { console.error('Claude Statusline: setup error:', e); }
}

// ─── Rate cache ───────────────────────────────────────────────────────────────

const CACHE_STALE_SECS   = 120;
const CACHE_DISCARD_SECS = 86400;

// The last rate limits that resolved to something, held so a refresh which
// resolves nothing has a reading to fall back on rather than an empty line.
let rememberedLimits: RememberedRateLimits | null = null;

function readRateCache(): CacheResult | null {
  try {
    if (!fs.existsSync(RATE_CACHE_PATH)) { return null; }
    const data = JSON.parse(fs.readFileSync(RATE_CACHE_PATH, 'utf8')) as RateCache;
    const age = Math.floor(Date.now() / 1000) - (data.ts || 0);
    if (age > CACHE_DISCARD_SECS) { return null; }
    return { data, stale: age > CACHE_STALE_SECS };
  } catch { return null; }
}

// ─── OAuth usage API (api.anthropic.com — no Cloudflare) ─────────────────────

interface OAuthUsage {
  five_hour?: { utilization: number; resets_at: string | null };
  seven_day?:  { utilization: number; resets_at: string | null };
}

let apiUsageCache: { data: OAuthUsage; ts: number } | null = null;
const API_CACHE_SECS = 60;

// The last call's outcome, so a failure can be waited out. Without this every
// refresh during an outage means another call, and every one of them can fail.
let lastFetchAttempt: FetchAttempt | null = null;

async function fetchOAuthUsage(): Promise<OAuthUsage | null> {
  // Use cached result if fresh
  if (apiUsageCache && (Date.now() / 1000 - apiUsageCache.ts) < API_CACHE_SECS) {
    return apiUsageCache.data;
  }
  if (!shouldAttemptFetch(lastFetchAttempt)) { return null; }
  lastFetchAttempt = { lastAttempt: Date.now(), succeeded: false };
  try {
    const token = loadCredentials()?.accessToken;
    if (!token) { return null; }

    // api.anthropic.com — no Cloudflare, accepts OAuth Bearer token
    const raw = await exec(
      `curl -s --max-time 8 ` +
      `-H "Authorization: Bearer ${token}" ` +
      `-H "anthropic-beta: oauth-2025-04-20" ` +
      `-H "User-Agent: claude-cli/2.1.0 (external, cli)" ` +
      `-H "Content-Type: application/json" ` +
      `"https://api.anthropic.com/api/oauth/usage"`,
      10000
    );
    if (!raw) { return null; }
    const json = JSON.parse(raw) as OAuthUsage;
    if (json.five_hour || json.seven_day) {
      apiUsageCache = { data: json, ts: Date.now() / 1000 };
      lastFetchAttempt = { lastAttempt: Date.now(), succeeded: true };
      return json;
    }
    return null;
  } catch { return null; }
}

// ─── Credentials ─────────────────────────────────────────────────────────────

// Where the credentials live is platform-specific; `readCredentials` owns that
// decision. This binds it to the real Keychain and filesystem — both readers
// throw on absence, which the module reads as "this source has nothing".
function loadCredentials(): OAuthCredentials | null {
  return readCredentials({
    platform: process.platform,
    keychain: () => cp.execSync(
      `security find-generic-password -s ${JSON.stringify(KEYCHAIN_SERVICE)} -w`,
      { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim(),
    readFile: () => fs.readFileSync(CREDENTIALS_PATH, 'utf8'),
  });
}

function readSubscriptionType(): string {
  return loadCredentials()?.subscriptionType ?? '';
}

// ─── Transcript helpers ───────────────────────────────────────────────────────

function findTranscripts(cwd: string): string[] {
  const roots = [
    path.join(os.homedir(), '.claude', 'projects'),
    path.join(os.homedir(), '.config', 'claude', 'projects'),
  ];
  const files: { file: string; mtime: number; matchesCwd: boolean }[] = [];
  const cwdSeg = path.basename(cwd).toLowerCase();
  const walk = (dir: string) => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); }
        else if (e.name.endsWith('.jsonl')) {
          const { mtimeMs } = fs.statSync(full);
          files.push({ file: full, mtime: mtimeMs, matchesCwd: path.dirname(full).toLowerCase().includes(cwdSeg) });
        }
      }
    } catch { /* skip */ }
  };
  roots.forEach(walk);
  return files
    .sort((a, b) => (a.matchesCwd === b.matchesCwd ? b.mtime - a.mtime : a.matchesCwd ? -1 : 1))
    .map(f => f.file);
}

function parseTranscript(filePath: string): { rawModel: string; effort: string; totalTokens: number; sessionMin: number | null } {
  let rawModel = ''; let effort = ''; let totalTokens = 0; let sessionMin: number | null = null;
  try {
    const stat = fs.statSync(filePath);
    const elapsed = Math.floor((Date.now() - stat.birthtimeMs) / 60000);
    sessionMin = elapsed > 0 ? elapsed : null;
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && !rawModel; i--) {
      try {
        const e = JSON.parse(lines[i]);
        const c = e.message?.model || e.model || null;
        if (c && typeof c === 'string' && c.startsWith('claude')) {
          rawModel = c;
          // Taken from the entry that supplied the model, not from whichever
          // entry mentioned effort most recently. A session that switched
          // models mid-run would otherwise pair one model with another's
          // effort and state something that never happened.
          if (typeof e.effort === 'string') { effort = e.effort; }
        }
      } catch { continue; }
    }
    // Last-seen rather than maximum-seen. A maximum never decreases, so after an
    // auto-compaction the total stayed pinned at the pre-compaction peak for the
    // rest of the session; taking the latest reading lets compaction correct
    // itself as subsequent entries report the smaller window. Only assistant
    // entries count: they carry a snapshot of the whole window, whereas a
    // subagent's usage describes a different window entirely and would overwrite
    // the session's own figure with an unrelated one.
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.type !== 'assistant' || e.isSidechain) { continue; }
        const u = e.message?.usage || e.usage;
        if (u) {
          const t = (u.input_tokens || 0) + (u.output_tokens || 0) +
            (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          // An interrupted turn can record a usage block before any tokens are
          // counted. That zero is the absence of a reading, not a measurement of
          // an empty window: latching onto it would blank the bar mid-session,
          // which is a louder error than the stale peak this loop exists to fix.
          if (t > 0) { totalTokens = t; }
        }
      } catch { continue; }
    }
  } catch { /* ignore */ }
  return { rawModel, effort, totalTokens, sessionMin };
}

// ─── Core data fetch ──────────────────────────────────────────────────────────

async function fetchStatusData(): Promise<StatusData> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  const folder = path.basename(cwd);
  const claudeCodeInstalled = fs.existsSync(CLAUDE_DIR) || !!which('claude');

  // ── Rate limits: 3 sources in priority order ──────────────────────────────
  // Source A: rate-cache.json (written by statusline.sh from live CLI payload — most accurate)
  // Source B: OAuth API (api.anthropic.com/api/oauth/usage — no Cloudflare)
  // Source C: stale cache (last known values)

  let cacheStale = false;
  let cachedModel = '', cachedContextPct = 0, cachedCwd = '';

  const cacheResult = readRateCache();
  if (cacheResult) {
    const c = cacheResult.data;
    cacheStale    = cacheResult.stale;
    cachedModel   = c.model || '';
    cachedContextPct = c.context_pct || 0;
    cachedCwd     = c.cwd || '';
  }

  // A readable cache no longer implies usable rate limits: it may carry the
  // zeroes written when the CLI payload had no rate_limits key at all. Consult
  // the OAuth API whenever the cache is stale or leaves a window unknown.
  let limits = resolveRateLimits({ cache: cacheResult?.data ?? null, oauth: null });
  if (cacheStale || !limits.session || !limits.weekly) {
    const oauthData = await fetchOAuthUsage();
    if (oauthData) {
      const fresh = resolveRateLimits({ cache: cacheResult?.data ?? null, oauth: oauthData });
      // OAuth data is fresh, so it only clears staleness if it actually
      // supplied something the cache could not.
      if (!limits.session || !limits.weekly) { cacheStale = false; }
      limits = fresh;
    }
  }

  // Both sources are intermittent — the cache is only rewritten while the user
  // is active, and the API can fail on its own — so a refresh that resolved
  // nothing is a gap rather than news. Hold the last reading across it, marked
  // stale, instead of letting the segments blink out and back in (#27).
  // Only a reading this refresh actually resolved is worth remembering. Re-
  // storing a remembered one would keep pushing its timestamp forward and it
  // could never age out.
  if (limits.session || limits.weekly) {
    rememberedLimits = { limits, at: Date.now() };
  }

  const held = rememberRateLimits(limits, rememberedLimits);
  limits = held.limits;
  if (held.stale) { cacheStale = true; }

  const rateLimitsAvailable = !!(limits.session || limits.weekly);

  // ── Model & context ───────────────────────────────────────────────────────
  let rawModel = cachedModel && cachedModel !== 'Claude' ? cachedModel : '';
  // Effort is only ever known from a transcript, while the model name usually
  // comes from the cache. Pairing the two across sources would let a cached
  // model be labelled with an effort from a different session, so this is set
  // only where the model it qualifies was read from the same transcript entry.
  let effort = '';
  let contextPct = 0;
  let sessionMin: number | null = null;
  let source = rateLimitsAvailable ? (cacheStale ? 'stale-cache' : 'rate-cache') : 'none';

  const transcripts = findTranscripts(cwd);
  const newestTranscript = transcripts.find(t => !t.includes('/subagents/'));

  // The denominator the percentage is measured against, resolved before the
  // transcript arithmetic below so both percentage sites share it.
  const contextWindowOverride = vscode.workspace
    .getConfiguration('claudeStatusline')
    .get<string>('contextWindowSize', '');
  let contextWindow = resolveContextWindow(rawModel, contextWindowOverride);
  let resolvedFromTranscript = false;

  // Which measurement produced `contextPct`, recorded as the branches below run
  // so the token count can be derived from the same source. This observes the
  // precedence logic; it does not participate in it.
  let pctFromTranscript = false;
  let transcriptTokens = 0;

  if (newestTranscript) {
    const newestParsed = parseTranscript(newestTranscript);
    sessionMin = newestParsed.sessionMin;
    transcriptTokens = newestParsed.totalTokens;
    // The transcript's own model beats the cache's: it describes the session
    // whose tokens are being divided by this number.
    if (newestParsed.rawModel) {
      contextWindow = resolveContextWindow(newestParsed.rawModel, contextWindowOverride);
      resolvedFromTranscript = true;
      // The cache names the model but never its effort, so without this the
      // effort segment would vanish in the common case of a fresh cache. The
      // transcript may be adopted only when it agrees about which model is
      // running: same model, same session, so its effort describes what the
      // line already says. A disagreement means they are describing different
      // sessions, and no effort is better than one attached to the wrong model.
      if (prettifyModelName(newestParsed.rawModel) === prettifyModelName(rawModel)) {
        effort = newestParsed.effort;
      }
    }

    // Detect new session: transcript created AFTER last cache write
    const cacheTs = cacheResult ? cacheResult.data.ts : 0;
    const transcriptBtime = newestParsed.sessionMin !== null
      ? Math.floor(Date.now() / 1000) - (newestParsed.sessionMin * 60)
      : 0;
    const isNewerThanCache = transcriptBtime > cacheTs + 30;

    if (isNewerThanCache || newestParsed.totalTokens === 0) {
      // New session started after last cache — use transcript tokens
      contextPct = newestParsed.totalTokens > 0
        ? Math.min(100, Math.round((newestParsed.totalTokens / contextWindow) * 100))
        : 0;
      if (newestParsed.totalTokens === 0) { source = 'new-session'; }
      else { source = 'transcript'; }
      // Both outcomes divide the parsed total: zero tokens is a real count of
      // zero, not an absent measurement.
      pctFromTranscript = true;
    } else if (!cacheStale && cachedContextPct > 0) {
      // Cache is fresh and same session — trust exact % from CLI payload
      contextPct = cachedContextPct;
    } else {
      // Stale cache — estimate from transcript tokens
      contextPct = newestParsed.totalTokens > 0
        ? Math.min(100, Math.round((newestParsed.totalTokens / contextWindow) * 100))
        : cachedContextPct;
      // Only the first outcome measured the transcript; the fallback is the
      // cached percentage, which the parsed total does not describe.
      pctFromTranscript = newestParsed.totalTokens > 0;
    }

    if (!rawModel && newestParsed.rawModel) {
      rawModel = newestParsed.rawModel;
      effort = newestParsed.effort;
      if (source === 'none') { source = 'transcript'; }
    }
  } else if (!cacheStale && cachedContextPct > 0) {
    contextPct = cachedContextPct;
  }

  // Fallback model from additional transcripts
  if (!rawModel) {
    for (const t of transcripts.slice(1, 10)) {
      if (t.includes('/subagents/')) { continue; }
      const p = parseTranscript(t);
      if (p.rawModel) { rawModel = p.rawModel; effort = p.effort; break; }
    }
  }

  // Last resort: settings.json model key
  if (!rawModel) {
    try {
      if (fs.existsSync(SETTINGS_PATH)) {
        const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        if (s.model && typeof s.model === 'string') { rawModel = s.model; source = 'settings'; }
      }
    } catch { /* ignore */ }
  }

  // The two fallbacks above only run when no model was known earlier, so this
  // fills in a window that was resolved from an empty identifier. It never
  // overwrites one derived from the transcript actually being measured.
  if (!resolvedFromTranscript) {
    contextWindow = resolveContextWindow(rawModel, contextWindowOverride);
  }

  // Git branch
  let branch: string | null = null;
  const gb = await exec(`git -C "${cwd}" symbolic-ref --short HEAD 2>/dev/null`);
  if (gb) { branch = gb; }
  else { const sha = await exec(`git -C "${cwd}" rev-parse --short HEAD 2>/dev/null`); if (sha) { branch = sha; } }

  // Derived last, so the window it divides by is the one the percentage above
  // was actually measured against.
  const contextTokens = resolveContextTokens({
    pct: contextPct,
    window: contextWindow,
    transcriptTokens,
    fromTranscript: pctFromTranscript,
  });

  return {
    model: prettifyModelName(rawModel),
    effort,
    rawModel, contextPct, contextWindow, contextTokens, branch,
    limits,
    sessionMin, folder, cwd, source,
    subscriptionType: readSubscriptionType(),
    claudeCodeInstalled,
    rateLimitsAvailable,
    cacheStale,
  };
}

// ─── Status bar ───────────────────────────────────────────────────────────────

// Reads the configuration on every build rather than capturing it at
// activation, so a settings change takes effect on the next refresh tick
// without a window reload. The defaults here are a fallback for a missing
// contribution point only — package.json is what a user actually gets.
function readSegmentSettings(cfg: vscode.WorkspaceConfiguration): SegmentSettings {
  return {
    showModel:           cfg.get('showModel') ?? true,
    showEffort:          cfg.get('showEffort') ?? true,
    showContextBar:      cfg.get('showContextBar') ?? true,
    barWidth:            cfg.get<string>('barWidth') ?? 'medium',
    barStyle:            cfg.get<string>('barStyle') ?? 'solid',
    showRateLimits:      cfg.get('showRateLimits') ?? true,
    showSessionReset:    cfg.get('showSessionReset') ?? true,
    showWeeklyReset:     cfg.get('showWeeklyReset') ?? true,
    showGitBranch:       cfg.get('showGitBranch') ?? false,
    showSessionDuration: cfg.get('showSessionDuration') ?? true,
    showFolder:          cfg.get('showFolder') ?? false,
    showSubscription:    cfg.get('showSubscription') ?? true,
  };
}

function buildTooltip(data: StatusData): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.appendMarkdown(`## $(sparkle) Claude Statusline\n\n`);
  md.appendMarkdown(`| | |\n|---|---|\n`);
  md.appendMarkdown(`| **Model** | \`${data.model}\`${data.effort ? ` · \`${data.effort}\` effort` : ''} |\n`);
  md.appendMarkdown(`| **Context** | ${colorThreshold(data.contextPct) || '🟢'} \`${progressBar(data.contextPct, 20)}\` **${data.contextPct}%** (${formatTokenCount(data.contextTokens)} / ${formatWindowSize(data.contextWindow)}) |\n`);
  if (data.branch) { md.appendMarkdown(`| **Branch** | \`${data.branch}\` |\n`); }
  {
    // Each window is reported on its own: one may be measured while the other
    // is not, and the tooltip is the only place that can say so in words.
    const stale = data.cacheStale ? ' (~stale)' : '';
    const rows: [string, typeof data.limits.session][] = [
      ['Session usage', data.limits.session],
      ['Weekly limit', data.limits.weekly],
    ];
    for (const [label, window] of rows) {
      if (!window) {
        md.appendMarkdown(`| **${label}** | _unavailable_ |\n`);
        continue;
      }
      const cd = formatCountdown(window.resetsAt);
      md.appendMarkdown(`| **${label}** | ${colorThreshold(window.pct) || '🟢'} **${window.pct}%**${cd ? ` (resets in ${cd})` : ''}${stale} |\n`);
    }
  }
  if (data.sessionMin !== null) { md.appendMarkdown(`| **Session** | ${formatDuration(data.sessionMin)} |\n`); }
  if (data.subscriptionType)    { md.appendMarkdown(`| **Plan** | \`${data.subscriptionType}\` |\n`); }
  md.appendMarkdown(`| **Folder** | \`${data.cwd}\` |\n`);
  md.appendMarkdown(`| **Source** | \`${data.source}\` |\n`);

  if (!data.claudeCodeInstalled) {
    md.appendMarkdown(`\n> 💡 Install [Claude Code CLI](https://claude.ai/install) to unlock full statusline\n\n`);
  } else if (!data.rateLimitsAvailable) {
    md.appendMarkdown(
      `\n> ⚠️ **Rate limit data unavailable.** Claude Code did not report limits ` +
      `and the usage API could not be reached — this usually means no valid ` +
      `credentials, or no prompt run yet in Claude Code. Usage is never estimated, ` +
      `so these segments are hidden rather than shown as 0%.\n\n`,
    );
  } else if (data.cacheStale) {
    md.appendMarkdown(`\n> ℹ️ Showing last known values (~) — refreshes on next Claude Code prompt\n\n`);
  }

  md.appendMarkdown(`\n---\n`);
  md.appendMarkdown(`[$(refresh) Refresh](command:claudeStatusline.refresh)   `);
  md.appendMarkdown(`[$(gear) Settings](command:claudeStatusline.openSettings)`);
  return md;
}

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  ensureStatuslineScript();

  const cfg = vscode.workspace.getConfiguration('claudeStatusline');
  const alignment = cfg.get<string>('alignment') === 'right'
    ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left;

  const statusBar = vscode.window.createStatusBarItem(alignment, cfg.get<number>('priority') ?? 100);
  statusBar.text = '$(sparkle) Claude…';
  statusBar.command = 'claudeStatusline.showDetails';
  statusBar.show();

  let lastData: StatusData | null = null;

  const refresh = async () => {
    try {
      const data = await fetchStatusData();
      lastData = data;
      const cfg2 = vscode.workspace.getConfiguration('claudeStatusline');
      statusBar.text = buildStatusText(data, readSegmentSettings(cfg2));
      statusBar.tooltip = buildTooltip(data);
      statusBar.backgroundColor = data.contextPct >= 80
        ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    } catch (e) {
      statusBar.text = '$(sparkle) Claude $(error)';
      statusBar.tooltip = `Error: ${e}`;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeStatusline.refresh', refresh),

    vscode.commands.registerCommand('claudeStatusline.showDetails', () => {
      if (!lastData) { return; }
      vscode.window.showInformationMessage([
        `Model: ${lastData.model}${lastData.effort ? ` (${lastData.effort} effort)` : ''}`,
        `Context: ${lastData.contextPct}% (${formatTokenCount(lastData.contextTokens)} / ${formatWindowSize(lastData.contextWindow)})`,
        lastData.rateLimitsAvailable
          ? `Session: ${lastData.limits.session ? `${lastData.limits.session.pct}%` : 'unavailable'}` +
            `  Weekly: ${lastData.limits.weekly ? `${lastData.limits.weekly.pct}%` : 'unavailable'}`
          : 'Rate limits: unavailable',
        lastData.limits.session?.resetsAt ? `Resets in: ${formatCountdown(lastData.limits.session.resetsAt)}` : null,
        lastData.branch ? `Branch: ${lastData.branch}` : null,
        lastData.sessionMin !== null ? `Session: ${formatDuration(lastData.sessionMin)}` : null,
        `Source: ${lastData.source}`,
      ].filter(Boolean).join('\n'));
    }),

    vscode.commands.registerCommand('claudeStatusline.diagnose', async () => {
      const out = vscode.window.createOutputChannel('Claude Statusline Diagnostics');
      out.clear();
      out.appendLine('=== Claude Statusline Diagnostics ===\n');

      out.appendLine(`statusline.sh: ${STATUSLINE_PATH}`);
      if (fs.existsSync(STATUSLINE_PATH)) {
        const c = fs.readFileSync(STATUSLINE_PATH, 'utf8');
        out.appendLine(`  version: ${c.match(/Claude Statusline v(\S+)/)?.[1] ?? 'unknown'}`);
        out.appendLine(`  up-to-date: ${isCurrentScript(c)}`);
      } else { out.appendLine('  NOT FOUND'); }

      out.appendLine('');
      out.appendLine(`rate-cache.json: ${RATE_CACHE_PATH}`);
      if (fs.existsSync(RATE_CACHE_PATH)) {
        const c = JSON.parse(fs.readFileSync(RATE_CACHE_PATH, 'utf8')) as RateCache;
        const age = Math.floor(Date.now() / 1000) - c.ts;
        out.appendLine(`  5h: ${c.r5}%  7d: ${c.r7}%  ctx: ${c.context_pct}%`);
        out.appendLine(`  model: ${c.model}`);
        out.appendLine(`  age: ${age}s ${age > CACHE_STALE_SECS ? '(STALE)' : '(fresh)'}`);
      } else { out.appendLine('  NOT FOUND — open Claude Code CLI once'); }

      out.appendLine('');
      out.appendLine('Testing OAuth API (api.anthropic.com/api/oauth/usage)...');
      const oauth = await fetchOAuthUsage();
      if (oauth) {
        out.appendLine(`  ✓ 5h: ${Math.round(oauth.five_hour?.utilization ?? 0)}%  7d: ${Math.round(oauth.seven_day?.utilization ?? 0)}%`);
      } else {
        out.appendLine('  ✗ Failed (no credentials or network error)');
      }

      out.appendLine('');
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
      const ts = findTranscripts(cwd);
      out.appendLine(`Transcripts: ${ts.length} found`);
      ts.slice(0, 3).filter(t => !t.includes('/subagents/')).forEach(t => {
        const p = parseTranscript(t);
        out.appendLine(`  ${path.basename(t)}: model="${p.rawModel || 'not found'}" tokens=${p.totalTokens}`);
      });

      if (lastData) {
        const fmt = (w: { pct: number } | null) => w ? `${w.pct}%` : 'n/a';
        out.appendLine(`\nCurrent: "${lastData.model}" ctx=${lastData.contextPct}% 5h=${fmt(lastData.limits.session)} 7d=${fmt(lastData.limits.weekly)} src=${lastData.source}`);
      }
      out.show();
    }),

    vscode.commands.registerCommand('claudeStatusline.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'claudeStatusline');
    }),
  );

  refresh();
  const timer = setInterval(refresh, (cfg.get<number>('refreshInterval') ?? 5) * 1000);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.window.onDidChangeActiveTextEditor(refresh),
    { dispose: () => clearInterval(timer) },
    statusBar,
  );
}

export function deactivate() {}
