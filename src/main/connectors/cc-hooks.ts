/**
 * connectors/cc-hooks.ts — the Claude Code side of the wiring (Phase 15,
 * docs/07): renders the curl --config files (port discovery, same delivery
 * as zcode) and installs/uninstalls hook registrations into
 * ~/.claude/settings.json.
 *
 * Spike facts (2026-09-20, CC 2.1.234 + official hooks reference):
 * - hooks live at the TOP-LEVEL `hooks` key of settings.json, shaped
 *   event → [{ matcher?, hooks: [{ type: 'command', command, args?, timeout? }] }] —
 *   structurally the zcode vocabulary (zcode modelled itself on CC).
 * - exec form (command + args array) spawns directly with NO shell on
 *   Windows; curl.exe is a real exe, so exec form is the right form. Shell
 *   form would run through Git Bash — avoided.
 * - `timeout` is SECONDS here (zcode used ms).
 * - NO `hooks.enabled` flag exists (hooks are on when present); the global
 *   kill is `disableAllHooks`, which we never touch.
 * - settings.json is hot-reloaded by CC's file watcher — no client restart
 *   needed after install (unlike zcode).
 * - matcher semantics: plain charset = exact/`|` list; any regex char =
 *   unanchored RegExp.test (same family as zcode — the negative-lookahead
 *   "everything else" pattern carries the same §7.1-style anchoring watch
 *   item).
 *
 * Install MERGES: foreign hooks and every other top-level key (env with
 * secrets, model, permissions…) survive untouched; our entries are
 * recognized by the EXACT cfg file path in their args, so reinstall is
 * idempotent and uninstall is a precise filter (v0.4.0 hardening via
 * config-io: serialization, .petween-bak, random tmp, corrupt-file refusal).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readConfigObject, removeBackup, serializedWrite, writeConfigAtomic } from './config-io'
import type { CcHookKind } from './cc-connector'

/** CC event registrations: petween kind → CC event + optional tool matcher. */
const CC_EVENTS: ReadonlyArray<{ kind: CcHookKind; event: string; matcher?: string }> = [
  { kind: 'session-start', event: 'SessionStart' },
  { kind: 'user-prompt-submit', event: 'UserPromptSubmit' },
  // Edit-class tools (exact list — plain charset, no regex needed).
  { kind: 'pre-tool-edit', event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit' },
  { kind: 'pre-tool-command', event: 'PreToolUse', matcher: 'Bash' },
  // "everything else" via negative lookahead — carries the same anchoring
  // watch item as zcode's pre-tool-other matcher (docs/07 §6).
  { kind: 'pre-tool-other', event: 'PreToolUse', matcher: '^(?!(?:Edit|Write|MultiEdit|NotebookEdit|Bash)$)' },
  { kind: 'post-tool', event: 'PostToolUse' },
  { kind: 'post-tool', event: 'PostToolUseFailure' },
  // Both map onto the waiting visual: PermissionRequest = approval prompt,
  // Notification = "waiting for your input" idle nudge.
  { kind: 'permission-request', event: 'PermissionRequest' },
  { kind: 'permission-request', event: 'Notification' },
  { kind: 'stop', event: 'Stop' },
  { kind: 'session-end', event: 'SessionEnd' },
]

/** The endpoint hooks POST to (registered in cc-routes.ts). */
export const CC_EVENT_PATH = '/api/petween-desktop/connector/cc/event'

/** Slashes forward so the same string works on disk, in JSON args and in cfg files. */
export function normalizeCfgPath(path: string): string {
  return path.replace(/\\/g, '/')
}

export function cfgFileName(kind: CcHookKind): string {
  return `${kind}.cfg`
}

export function renderCcCurlConfig(port: number, kind: CcHookKind): string {
  return [
    `request = "POST"`,
    `url = "http://127.0.0.1:${port}${CC_EVENT_PATH}?e=${kind}"`,
    `connect-timeout = 1`,
    `max-time = 2`,
    // A local proxy env var (e.g. Clash) must never intercept a loopback POST.
    `noproxy = "*"`,
    `silent`,
    '',
  ].join('\n')
}

/** (Re)writes every cfg file with the current port — run at every app boot. */
export async function writeCcHookConfigs(cfgDir: string, port: number): Promise<void> {
  await mkdir(cfgDir, { recursive: true })
  const kinds = new Set(CC_EVENTS.map(({ kind }) => kind))
  await Promise.all(
    [...kinds].map(async (kind) => {
      const file = join(cfgDir, cfgFileName(kind))
      await writeFile(file, renderCcCurlConfig(port, kind), 'utf8')
    }),
  )
}

type HookEntry = { type?: string; command?: string; args?: unknown; timeout?: number }
type MatcherGroup = { matcher?: string; hooks?: HookEntry[] }

/** One exec-form hook invocation of curl with the cfg file + stdin body. */
function hookFor(cfgDir: string, kind: CcHookKind): HookEntry {
  return {
    type: 'command',
    command: 'curl.exe',
    args: ['--config', `${normalizeCfgPath(cfgDir)}/${cfgFileName(kind)}`, '--data-binary', '@-'],
    // CC timeout unit is SECONDS (zcode used ms). SessionEnd hooks share a
    // 1.5s completion budget in CC — the loopback curl fires in ms, well
    // inside it.
    timeout: 5,
  }
}

/** The top-level hooks object to merge into settings.json. */
export function buildCcHookEvents(cfgDir: string): Record<string, MatcherGroup[]> {
  const merged: Record<string, MatcherGroup[]> = {}
  for (const { kind, event, matcher } of CC_EVENTS) {
    const group: MatcherGroup = matcher === undefined ? { hooks: [hookFor(cfgDir, kind)] } : { matcher, hooks: [hookFor(cfgDir, kind)] }
    merged[event] = [...(merged[event] ?? []), group]
  }
  return merged
}

/**
 * EXACT cfg-path ownership (v0.4.0 hardening): a hook is ours iff one of its
 * args equals one of the cfg files we render — a user copy parked under a
 * sibling dir (cc-hooks.bak/…) or any foreign curl is never matched.
 */
function isOurGroup(group: unknown, cfgDir: string): boolean {
  if (typeof group !== 'object' || group === null) return false
  const hooks = (group as MatcherGroup).hooks
  if (!Array.isArray(hooks)) return false
  const ours = new Set(
    [...new Set(CC_EVENTS.map(({ kind }) => kind))].map((kind) =>
      normalizeCfgPath(`${cfgDir}/${cfgFileName(kind)}`).toLowerCase(),
    ),
  )
  return hooks.some(
    (hook) =>
      typeof hook === 'object' &&
      hook !== null &&
      Array.isArray(hook.args) &&
      hook.args.some((arg) => typeof arg === 'string' && ours.has(normalizeCfgPath(arg).toLowerCase())),
  )
}

export interface CcHooksPaths {
  /** userData/cc-hooks — where the curl cfg files live. */
  cfgDir: string
  /** ~/.claude/settings.json — the Claude Code user configuration. */
  settingsPath: string
}

/**
 * Installs (or reinstalls — idempotent) the hook registrations. Foreign
 * entries and unrelated top-level keys are preserved; a malformed (non-array)
 * event value is REFUSED rather than silently dropped. CC hot-reloads the
 * file, so the registrations go live without a client restart.
 */
export function installCcHooks(paths: CcHooksPaths): Promise<void> {
  return serializedWrite(paths.settingsPath, async () => {
    const config = (await readConfigObject(paths.settingsPath)) ?? {}
    const rawHooks = config.hooks
    if (rawHooks !== undefined && (typeof rawHooks !== 'object' || rawHooks === null || Array.isArray(rawHooks))) {
      // Same refusal semantics as a malformed event value: malformed user
      // data is never silently replaced (phase-review consistency fix).
      throw new Error(`settings.json hooks is not an object — refusing to overwrite user data (${paths.settingsPath})`)
    }
    const hooks = (rawHooks ?? {}) as Record<string, unknown>

    const ours = buildCcHookEvents(paths.cfgDir)
    const merged: Record<string, unknown> = {}
    const seenEvents = new Set<string>(Object.keys(hooks))
    for (const [event, groups] of Object.entries(ours)) {
      const existing = hooks[event]
      if (existing !== undefined && !Array.isArray(existing)) {
        throw new Error(`settings.json hooks.${event} is not an array — refusing to overwrite user data (${paths.settingsPath})`)
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
    await writeConfigAtomic(paths.settingsPath, config)
  })
}

/**
 * Removes our hook registrations; a missing file is already clean. Returns
 * whether anything was removed.
 */
export function uninstallCcHooks(paths: CcHooksPaths): Promise<boolean> {
  return serializedWrite(paths.settingsPath, async () => {
    const config = await readConfigObject(paths.settingsPath)
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
    else delete config.hooks // back to no hooks key at all
    await writeConfigAtomic(paths.settingsPath, config)
    // Our tenancy ended — the backup (which mirrors the user's env secrets)
    // must not outlive it.
    await removeBackup(paths.settingsPath)
    return true
  })
}

/** True when our entries are present in settings.json (for the settings card). */
export async function ccHooksInstalled(paths: CcHooksPaths): Promise<boolean> {
  const config = await readConfigObject(paths.settingsPath)
  if (config === null) return false
  const hooks = config.hooks
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return false
  return Object.values(hooks as Record<string, unknown>).some(
    (groups) => Array.isArray(groups) && groups.some((group) => isOurGroup(group, paths.cfgDir)),
  )
}
