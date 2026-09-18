/**
 * connectors/zcode-hooks.ts — the zcode side of the wiring (docs/06 §2/§4):
 * renders the curl --config files (port discovery) and installs/uninstalls
 * hook registrations into ~/.zcode/cli/config.json.
 *
 * Install MERGES: foreign hooks, mcp servers, plugin state and every other
 * key survive untouched; our entries are recognized by the cfg-dir path inside
 * their args, so reinstall is idempotent and uninstall is a precise filter.
 * A corrupt config file is user data — install fails instead of clobbering.
 *
 * Pure Node; all paths injected. No hook ever parses stdin: the event kind is
 * encoded in the cfg URL, the session id travels as --data-urlencode with the
 * ${CLAUDE_SESSION_ID} template variable zcode expands (and injects as env).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ZcodeHookKind } from './zcode-connector'

/** Every event kind gets one cfg file; PostToolUseFailure shares post-tool. */
const CFG_BY_KIND: ReadonlyArray<{ kind: ZcodeHookKind; matcher?: string }> = [
  { kind: 'session-start' },
  { kind: 'user-prompt-submit' },
  { kind: 'pre-tool-edit', matcher: '^(Edit|Write|ApplyPatch)$' },
  { kind: 'pre-tool-command', matcher: '^Bash$' },
  // "everything else" via negative lookahead — assumes zcode applies matchers
  // as a raw RegExp.test (docs/06 §7.1 watch item).
  { kind: 'pre-tool-other', matcher: '^(?!(?:Edit|Write|ApplyPatch|Bash)$)' },
  { kind: 'post-tool' },
  { kind: 'permission-request' },
  { kind: 'stop' },
]

/** The endpoint hooks POST to (registered in zcode-routes.ts). */
export const ZCODE_EVENT_PATH = '/api/petween-desktop/connector/zcode/event'

/** Slashes forward so the same string works on disk, in JSON args and in cfg files. */
export function normalizeCfgPath(path: string): string {
  return path.replace(/\\/g, '/')
}

/** Windows path comparisons are case-insensitive. */
function sameCfgPath(a: string, b: string): boolean {
  return normalizeCfgPath(a).toLowerCase() === normalizeCfgPath(b).toLowerCase()
}

export function cfgFileName(kind: ZcodeHookKind): string {
  return `${kind}.cfg`
}

export function renderZcodeCurlConfig(port: number, kind: ZcodeHookKind): string {
  return [
    `request = "POST"`,
    `url = "http://127.0.0.1:${port}${ZCODE_EVENT_PATH}?e=${kind}"`,
    `connect-timeout = 1`,
    `max-time = 2`,
    // A local proxy env var (e.g. Clash) must never intercept a loopback POST.
    `noproxy = "*"`,
    `silent`,
    '',
  ].join('\n')
}

/** (Re)writes every cfg file with the current port — run at every app boot. */
export async function writeZcodeHookConfigs(cfgDir: string, port: number): Promise<void> {
  await mkdir(cfgDir, { recursive: true })
  await Promise.all(
    CFG_BY_KIND.map(async ({ kind }) => {
      const file = join(cfgDir, cfgFileName(kind))
      await writeFile(file, renderZcodeCurlConfig(port, kind), 'utf8')
    }),
  )
}

type HookEntry = { type?: string; command?: string; args?: unknown; timeoutMs?: number }
type MatcherGroup = { matcher?: string; hooks?: HookEntry[] }

/** One process-type hook invocation of curl with the cfg file + session id. */
function hookFor(cfgDir: string, kind: ZcodeHookKind): HookEntry {
  return {
    type: 'process',
    command: 'curl.exe',
    args: [`--config`, `${normalizeCfgPath(cfgDir)}/${cfgFileName(kind)}`, `--data-urlencode`, `session=\${CLAUDE_SESSION_ID}`],
    timeoutMs: 2500,
  }
}

const PRE_TOOL_KINDS = CFG_BY_KIND.filter(({ kind }) => kind.startsWith('pre-tool-'))

/** The hooks.events object to merge into the zcode config. */
export function buildZcodeHookEvents(cfgDir: string): Record<string, MatcherGroup[]> {
  const groups = (kinds: ReadonlyArray<{ kind: ZcodeHookKind; matcher?: string }>): MatcherGroup[] =>
    kinds.map(({ kind, matcher }) => {
      const hooks = [hookFor(cfgDir, kind)]
      return matcher === undefined ? { hooks } : { matcher, hooks }
    })
  const single = (kind: ZcodeHookKind): MatcherGroup[] => groups([{ kind }])
  return {
    SessionStart: single('session-start'),
    UserPromptSubmit: single('user-prompt-submit'),
    PreToolUse: groups(PRE_TOOL_KINDS),
    PostToolUse: single('post-tool'),
    PostToolUseFailure: single('post-tool'),
    PermissionRequest: single('permission-request'),
    Stop: single('stop'),
  }
}

function isOurGroup(group: unknown, cfgDir: string): boolean {
  if (typeof group !== 'object' || group === null) return false
  const hooks = (group as MatcherGroup).hooks
  if (!Array.isArray(hooks)) return false
  const dir = normalizeCfgPath(cfgDir)
  return hooks.some(
    (hook) =>
      typeof hook === 'object' &&
      hook !== null &&
      Array.isArray(hook.args) &&
      hook.args.some(
        (arg) => typeof arg === 'string' && sameCfgPath(normalizeCfgPath(arg).slice(0, dir.length), dir),
      ),
  )
}

async function readConfigObject(path: string): Promise<Record<string, unknown> | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null // missing file: fresh install
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('config root is not an object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(`zcode config is not valid JSON (${path}): ${String(error)}`)
  }
}

async function writeConfigAtomic(path: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.petween-tmp`
  await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
  await rename(tmp, path)
}

export interface ZcodeHooksPaths {
  /** userData/zcode-hooks — where the curl cfg files live. */
  cfgDir: string
  /** ~/.zcode/cli/config.json — the zcode user configuration. */
  zcodeConfigPath: string
}

/**
 * Installs (or reinstalls — idempotent) the hook registrations. Foreign
 * entries and unrelated top-level keys are preserved; `hooks.enabled` is set
 * true (configuration-file hooks are disabled by default in zcode).
 */
export async function installZcodeHooks(paths: ZcodeHooksPaths): Promise<void> {
  const config = (await readConfigObject(paths.zcodeConfigPath)) ?? {}
  const hooks = (typeof config.hooks === 'object' && config.hooks !== null ? config.hooks : {}) as Record<string, unknown>
  const events = (typeof hooks.events === 'object' && hooks.events !== null && !Array.isArray(hooks.events) ? hooks.events : {}) as Record<string, unknown>

  const ours = buildZcodeHookEvents(paths.cfgDir)
  const merged: Record<string, unknown> = {}
  const seenEvents = new Set<string>(Object.keys(events))
  for (const [name, groups] of Object.entries(ours)) {
    const existing = Array.isArray(events[name]) ? (events[name] as unknown[]) : []
    merged[name] = [...existing.filter((group) => !isOurGroup(group, paths.cfgDir)), ...groups]
    seenEvents.add(name)
  }
  // Foreign events we do not manage survive untouched.
  for (const name of seenEvents) {
    if (merged[name] === undefined) merged[name] = events[name]
  }

  config.hooks = { ...hooks, enabled: true, events: merged }
  await writeConfigAtomic(paths.zcodeConfigPath, config)
}

/**
 * Removes our hook registrations. When no events remain the runner flag goes
 * back to false (equivalent to the pristine state); a missing file is already
 * clean. Returns whether anything was removed.
 */
export async function uninstallZcodeHooks(paths: ZcodeHooksPaths): Promise<boolean> {
  const config = await readConfigObject(paths.zcodeConfigPath)
  if (config === null) return false
  const hooks = (typeof config.hooks === 'object' && config.hooks !== null ? config.hooks : null) as Record<string, unknown> | null
  if (hooks === null) return false
  const events = (typeof hooks.events === 'object' && hooks.events !== null && !Array.isArray(hooks.events) ? hooks.events : {}) as Record<string, unknown>

  let removed = false
  const next: Record<string, unknown> = {}
  for (const [name, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) {
      next[name] = groups
      continue
    }
    const kept = groups.filter((group) => {
      const ours = isOurGroup(group, paths.cfgDir)
      if (ours) removed = true
      return !ours
    })
    if (kept.length > 0) next[name] = kept
  }

  if (!removed) return false
  const hasEvents = Object.keys(next).length > 0
  config.hooks = { ...hooks, events: next, enabled: hasEvents ? (hooks.enabled ?? true) : false }
  await writeConfigAtomic(paths.zcodeConfigPath, config)
  return true
}

/** True when our entries are present in the zcode config (for the settings card). */
export async function zcodeHooksInstalled(paths: ZcodeHooksPaths): Promise<boolean> {
  const config = await readConfigObject(paths.zcodeConfigPath)
  if (config === null) return false
  const hooks = config.hooks
  if (typeof hooks !== 'object' || hooks === null) return false
  const events = (hooks as Record<string, unknown>).events
  if (typeof events !== 'object' || events === null || Array.isArray(events)) return false
  return Object.values(events).some(
    (groups) => Array.isArray(groups) && groups.some((group) => isOurGroup(group, paths.cfgDir)),
  )
}
