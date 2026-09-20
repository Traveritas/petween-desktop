/**
 * connectors/codex-hooks.ts — the OpenAI Codex CLI side of the wiring
 * (Phase 16, docs/08): renders the curl --config files (port discovery) and
 * installs/uninstalls hook registrations into ~/.codex/hooks.json.
 *
 * Spike facts (2026-09-20, codex-cli 0.154.0 + openai/codex source +
 * the machine's live hooks.json coexisting with deja-vu's hooks):
 * - hooks.json shape is CC-COMPATIBLE: `{ hooks: { <PascalCase event>:
 *   [{ matcher?, hooks: [{ type: 'command', command, timeout, statusMessage? }] }] } }`
 *   — Codex's engine is literally `ClaudeHooksEngine` (codex-rs/hooks).
 * - BUT the hook entry's command is a single STRING (no args array) run via
 *   `cmd.exe /C <line>` on Windows — so the cfg path must be double-quoted
 *   inside the command line (usernames can contain spaces).
 * - `timeout` is seconds.
 * - TRUST: Codex hashes every (event, matcher, group) and compares against
 *   a trusted-hash store — our install will surface a one-time trust
 *   confirmation in Codex's UI on the next session (documented on the
 *   settings card; `bypass_hook_trust` policy exists but is not ours to flip).
 * - Config hot-reload not established for hooks.json (unlike CC) — assume
 *   new sessions pick it up; the settings card says so.
 *
 * Install MERGES: foreign hooks (deja-vu's, user's own) and every other
 * top-level key survive; our entries are recognized by the exact cfg path
 * inside their command string, so reinstall is idempotent and uninstall is
 * a precise filter. config-io hardening (serialization, .petween-bak,
 * random tmp, corrupt-file refusal) applies.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readConfigObject, removeBackup, serializedWrite, writeConfigAtomic } from './config-io'
import type { CodexHookKind } from './codex-connector'

/**
 * The transport script every hook invokes: node reads the hook's stdin JSON
 * and POSTs it to the sink endpoint. WHY NODE AND NOT CURL (real-machine
 * forensic, 2026-09-20): under Codex's Windows hook runner, curl.exe fails
 * with exit 1 the moment it reads stdin while doing network (`--data-binary
 * @-`/`-d @-`, any quoting/wrapping) — stdin-only tools and network-only
 * curl both succeed; node.exe doing stdin+fetch works flawlessly and
 * DELIVERED. The port is read from the kind's cfg file (the cfgs stay the
 * boot-time port-discovery carrier).
 */
const SINK_SCRIPT = `// Petween Codex hook sink (generated): POST the hook's stdin JSON to the app.
const fs = require('fs')
const path = require('path')
const kind = process.argv[2] || 'session-start'
let port = 17777
try {
  const m = /127\\.0\\.0\\.1:(\\d+)/.exec(fs.readFileSync(path.join(__dirname, kind + '.cfg'), 'utf8'))
  if (m) port = Number(m[1])
} catch {}
let body = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { body += d })
process.stdin.on('end', () => {
  fetch('http://127.0.0.1:' + port + '/api/petween-desktop/connector/codex/event?e=' + kind, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }).then(() => process.exit(0), () => process.exit(0))
  setTimeout(() => process.exit(0), 1800)
})
`

/** Locate the system node.exe (the sink transport needs it). null = absent. */
export function findNodePath(pathEnv: string | undefined): string | null {
  if (typeof pathEnv !== 'string' || pathEnv === '') return null
  const fsSync = require('node:fs') as typeof import('node:fs')
  for (const dir of pathEnv.split(';')) {
    const trimmed = dir.trim()
    if (trimmed === '') continue
    for (const candidate of [join(trimmed, 'node.exe'), trimmed]) {
      const asExe = candidate.toLowerCase().endsWith('.exe') ? candidate : `${candidate}.exe`
      try {
        if (fsSync.statSync(asExe).isFile()) return asExe.replace(/\\/g, '/')
      } catch {
        // keep searching
      }
    }
  }
  return null
}

/**
 * Codex event registrations. NO PreToolUse matchers: Codex compiles matchers
 * with the Rust regex crate, which does NOT support look-around — the
 * negative-lookahead "everything else" pattern from the CC/zcode family is
 * rejected outright (real-machine report 2026-09-20). Instead ONE bare
 * (match-all) PreToolUse group posts every tool event, and the ROUTE
 * reclassifies edit/command/other from the payload's tool_name — our own TS
 * unions are the single source of truth, immune to matcher-semantics drift.
 *
 * SessionEnd/Interrupt events have their timeout clamped to 3s by Codex —
 * we set 3 up front so no clamp warning fires at startup.
 */
const CODEX_EVENTS: ReadonlyArray<{ kind: CodexHookKind; event: string; timeout?: number }> = [
  { kind: 'session-start', event: 'SessionStart' },
  { kind: 'user-prompt-submit', event: 'UserPromptSubmit' },
  // Catch-all: the route reclassifies per tool_name (see classifyCodexToolKind).
  { kind: 'pre-tool-other', event: 'PreToolUse' },
  { kind: 'post-tool', event: 'PostToolUse' },
  { kind: 'permission-request', event: 'PermissionRequest' },
  { kind: 'stop', event: 'Stop' },
  // A user interrupt aborts the turn — the immediate idle baseline (without
  // this the pet would work-face until the 30min watchdog).
  { kind: 'session-start', event: 'Interrupt', timeout: 3 },
  { kind: 'session-end', event: 'SessionEnd', timeout: 3 },
]

/** Edit-class tool names (Codex-native + the CC-compat aliases). */
export const CODEX_EDIT_TOOLS: ReadonlySet<string> = new Set(['apply_patch', 'write_file', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** Command-class tool names (Codex-native + the CC-compat aliases). */
export const CODEX_COMMAND_TOOLS: ReadonlySet<string> = new Set(['shell', 'Bash', 'local_shell', 'shell_command', 'exec_command'])

/** Route-side classification of a PreToolUse payload by its real tool_name. */
export function classifyCodexToolKind(toolName: string | undefined): CodexHookKind {
  if (toolName !== undefined && CODEX_EDIT_TOOLS.has(toolName)) return 'pre-tool-edit'
  if (toolName !== undefined && CODEX_COMMAND_TOOLS.has(toolName)) return 'pre-tool-command'
  return 'pre-tool-other'
}

/** The endpoint hooks POST to (registered in codex-routes.ts). */
export const CODEX_EVENT_PATH = '/api/petween-desktop/connector/codex/event'

/** Slashes forward so the same string works on disk, in cfg files and in command lines. */
export function normalizeCfgPath(path: string): string {
  return path.replace(/\\/g, '/')
}

export function cfgFileName(kind: CodexHookKind): string {
  return `${kind}.cfg`
}

export function renderCodexCurlConfig(port: number, kind: CodexHookKind): string {
  return [
    `request = "POST"`,
    `url = "http://127.0.0.1:${port}${CODEX_EVENT_PATH}?e=${kind}"`,
    `connect-timeout = 1`,
    `max-time = 2`,
    // A local proxy env var (e.g. Clash) must never intercept a loopback POST.
    `noproxy = "*"`,
    `silent`,
    '',
  ].join('\n')
}

/**
 * (Re)writes every cfg file with the current port — run at every app boot.
 * The cfgs are the PORT-DISCOVERY carrier only (the sink script reads the
 * port from its kind's cfg); the hook commands run the sink, not curl.
 */
export async function writeCodexHookConfigs(cfgDir: string, port: number): Promise<void> {
  await mkdir(cfgDir, { recursive: true })
  const kinds = new Set(CODEX_EVENTS.map(({ kind }) => kind))
  await Promise.all(
    [...kinds].map(async (kind) => {
      const file = join(cfgDir, cfgFileName(kind))
      await writeFile(file, renderCodexCurlConfig(port, kind), 'utf8')
    }),
  )
  await writeFile(join(cfgDir, 'sink.js'), SINK_SCRIPT, 'utf8')
}

type HookEntry = { type?: string; command?: string; timeout?: number; statusMessage?: string }
type MatcherGroup = { matcher?: string; hooks?: HookEntry[] }

/**
 * One hook invocation: `<node.exe backslashed> <cfgDir>/sink.js <kind>` —
 * NO quotes: a leading quoted token makes cmd's /C quote-stripping rule
 * mangle the line ("命令语法不正确", exit 1 — reproduced verbatim), while the
 * unquoted backslash-exe + forward-slash-args form is proven to run under
 * the COMSPEC runner AND deliver (the deja-vu command form; also bash-safe
 * for the script path). Spaces in either path are a documented limitation
 * (quote-breaks under cmd). Timeout is seconds.
 */
function hookFor(cfgDir: string, kind: CodexHookKind, nodePath: string, timeout = 5): HookEntry {
  const exe = nodePath.replace(/\//g, '\\')
  return {
    type: 'command',
    command: `${exe} ${normalizeCfgPath(cfgDir)}/sink.js ${kind}`,
    timeout,
  }
}

/** The top-level hooks object to merge into hooks.json. */
export function buildCodexHookEvents(cfgDir: string, nodePath: string): Record<string, MatcherGroup[]> {
  const merged: Record<string, MatcherGroup[]> = {}
  for (const { kind, event, timeout } of CODEX_EVENTS) {
    const group: MatcherGroup = { hooks: [hookFor(cfgDir, kind, nodePath, timeout)] }
    merged[event] = [...(merged[event] ?? []), group]
  }
  return merged
}

/**
 * EXACT cfg-path ownership: a hook is ours iff its command string contains
 * one of the cfg file paths we render (normalized, case-insensitive). The
 * LEGACY names are cfg files earlier versions rendered (pre-v0.6.2 split
 * PreToolUse matchers) — without them in the set, a reinstall would leave
 * the stale groups in place forever (real-machine report: 4 accumulated
 * groups). A foreign hook (deja-vu's, a user copy under a sibling dir)
 * never matches.
 */
const LEGACY_OWNED_CFG_NAMES = ['pre-tool-edit.cfg', 'pre-tool-command.cfg', 'pre-tool-other.cfg']

function isOurGroup(group: unknown, cfgDir: string): boolean {
  if (typeof group !== 'object' || group === null) return false
  const hooks = (group as MatcherGroup).hooks
  if (!Array.isArray(hooks)) return false
  const dir = normalizeCfgPath(cfgDir).toLowerCase()
  const ours = new Set<string>([`${dir}/sink.js`])
  for (const { kind } of CODEX_EVENTS) ours.add(normalizeCfgPath(`${cfgDir}/${cfgFileName(kind)}`).toLowerCase())
  for (const name of LEGACY_OWNED_CFG_NAMES) ours.add(`${dir}/${name}`)
  return hooks.some((hook) => {
    if (typeof hook !== 'object' || hook === null) return false
    const command = (hook as HookEntry).command
    if (typeof command !== 'string') return false
    const normalized = normalizeCfgPath(command).toLowerCase()
    for (const path of ours) {
      if (normalized.includes(path)) return true
    }
    return false
  })
}

export interface CodexHooksPaths {
  /** userData/codex-hooks — where the cfg files and sink.js live. */
  cfgDir: string
  /** ~/.codex/hooks.json — the Codex hook registrations. */
  hooksPath: string
  /** Absolute path of the system node.exe (the sink transport). */
  nodePath: string
}

/**
 * Installs (or reinstalls — idempotent) the hook registrations. Foreign
 * entries and unrelated top-level keys are preserved; malformed values are
 * REFUSED rather than silently replaced. NOTE: Codex hashes every hook
 * group — expect a one-time trust confirmation in Codex after installing
 * (or pre-seed config.toml [hooks.state] — docs/08 §3.1).
 */
export function installCodexHooks(paths: CodexHooksPaths): Promise<void> {
  return serializedWrite(paths.hooksPath, async () => {
    const config = (await readConfigObject(paths.hooksPath)) ?? {}
    const rawHooks = config.hooks
    if (rawHooks !== undefined && (typeof rawHooks !== 'object' || rawHooks === null || Array.isArray(rawHooks))) {
      throw new Error(`hooks.json hooks is not an object — refusing to overwrite user data (${paths.hooksPath})`)
    }
    const hooks = (rawHooks ?? {}) as Record<string, unknown>

    const ours = buildCodexHookEvents(paths.cfgDir, paths.nodePath)
    const merged: Record<string, unknown> = {}
    const seenEvents = new Set<string>(Object.keys(hooks))
    for (const [event, groups] of Object.entries(ours)) {
      const existing = hooks[event]
      if (existing !== undefined && !Array.isArray(existing)) {
        throw new Error(`hooks.json hooks.${event} is not an array — refusing to overwrite user data (${paths.hooksPath})`)
      }
      const kept = existing === undefined ? [] : (existing as unknown[])
      merged[event] = [...kept.filter((group) => !isOurGroup(group, paths.cfgDir)), ...groups]
      seenEvents.add(event)
    }
    // Foreign events we do not manage survive untouched.
    for (const event of seenEvents) {
      if (merged[event] === undefined) merged[event] = hooks[event]
    }

    config.hooks = merged
    await writeConfigAtomic(paths.hooksPath, config)
  })
}

/**
 * Removes our hook registrations; a missing file is already clean. Returns
 * whether anything was removed.
 */
export function uninstallCodexHooks(paths: CodexHooksPaths): Promise<boolean> {
  return serializedWrite(paths.hooksPath, async () => {
    const config = await readConfigObject(paths.hooksPath)
    if (config === null) return false
    const hooks = config.hooks
    if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return false

    let removed = false
    const next: Record<string, unknown> = {}
    for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
      if (!Array.isArray(groups)) {
        next[event] = groups
        continue
      }
      const kept = groups.filter((group) => {
        const owned = isOurGroup(group, paths.cfgDir)
        if (owned) removed = true
        return !owned
      })
      if (kept.length > 0) next[event] = kept
    }

    if (!removed) return false
    if (Object.keys(next).length > 0) config.hooks = next
    else delete config.hooks
    await writeConfigAtomic(paths.hooksPath, config)
    // Tenancy ended — drop the one-generation backup.
    await removeBackup(paths.hooksPath)
    return true
  })
}

/** True when our entries are present in hooks.json (for the settings card). */
export async function codexHooksInstalled(paths: CodexHooksPaths): Promise<boolean> {
  const config = await readConfigObject(paths.hooksPath)
  if (config === null) return false
  const hooks = config.hooks
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return false
  return Object.values(hooks as Record<string, unknown>).some(
    (groups) => Array.isArray(groups) && groups.some((group) => isOurGroup(group, paths.cfgDir)),
  )
}
