/**
 * codex hooks wiring: curl cfg rendering/port rewrite, the hooks.json shape
 * (CC-compatible events, but command STRINGS via cmd.exe /C), and the
 * merge-install / precise-uninstall contract (deja-vu style foreign hooks
 * survive untouched; corrupt files are never clobbered).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCodexHookEvents,
  classifyCodexToolKind,
  findNodePath,
  installCodexHooks,
  renderCodexCurlConfig,
  uninstallCodexHooks,
  writeCodexHookConfigs,
  codexHooksInstalled,
  CODEX_EVENT_PATH,
} from '../../src/main/connectors/codex-hooks'

const CFG_DIR = 'C:/Users/t/AppData/Roaming/petween-desktop/codex-hooks'
const NODE = 'D:/Nodejs/node.exe'

function paths(hooksPath: string): { cfgDir: string; hooksPath: string; nodePath: string } {
  return { cfgDir: CFG_DIR, hooksPath, nodePath: NODE }
}

async function withTempConfig<T>(
  initial: string | null,
  run: (hooksPath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'petween-cxhooks-'))
  try {
    const hooksPath = join(dir, 'hooks.json')
    if (initial !== null) await writeFile(hooksPath, initial, 'utf8')
    return await run(hooksPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('cfg rendering', () => {
  it('renders a POST cfg with the port, endpoint, kind and loopback guards', () => {
    const cfg = renderCodexCurlConfig(51401, 'pre-tool-edit')
    expect(cfg).toContain('request = "POST"')
    expect(cfg).toContain(`url = "http://127.0.0.1:51401${CODEX_EVENT_PATH}?e=pre-tool-edit"`)
    expect(cfg).toContain('connect-timeout = 1')
    expect(cfg).toContain('max-time = 2')
    expect(cfg).toContain('noproxy = "*"')
  })

  it('writeCodexHookConfigs writes one cfg per kind plus the node sink script', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'petween-cxcfg-'))
    try {
      await writeCodexHookConfigs(dir, 11111)
      const sink = await readFile(join(dir, 'sink.js'), 'utf8')
      expect(sink).toContain("process.argv[2]")
      expect(sink).toContain('connector/codex/event?e=')
      // The sink reads the port from its kind's cfg — spot-check one.
      const cfg = await readFile(join(dir, 'session-start.cfg'), 'utf8')
      expect(cfg).toContain(':11111')
      // A later boot rewrites with the new port.
      await writeCodexHookConfigs(dir, 22222)
      expect(await readFile(join(dir, 'session-start.cfg'), 'utf8')).toContain(':22222')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('buildCodexHookEvents', () => {
  it('invokes the NODE sink with the kind argument (curl stdin dies under Codex\'s runner)', () => {
    const events = buildCodexHookEvents(CFG_DIR, NODE)
    // ONE bare (match-all) PreToolUse group — no matchers at all: Codex
    // compiles them with the Rust regex crate (no look-around), so the
    // CC-style "everything else" pattern is rejected; classification moved
    // to the route (classifyCodexToolKind).
    const pre = events.PreToolUse
    expect(pre).toHaveLength(1)
    expect(pre[0].matcher).toBeUndefined()
    const hook = (pre[0].hooks ?? [])[0] as Record<string, unknown>
    expect(hook.type).toBe('command')
    expect(hook.timeout).toBe(5) // seconds
    // The proven cmd-runner form: backslash exe + forward-slash script, NO
    // quotes (a leading quoted token breaks cmd's /C quote-stripping).
    expect(hook.command).toBe(`D:\\Nodejs\\node.exe ${CFG_DIR}/sink.js pre-tool-other`)
  })

  it('covers the Codex event surface; Interrupt shares the session-start kind; clamp-capped events set timeout 3', () => {
    const events = buildCodexHookEvents(CFG_DIR, NODE)
    expect(Object.keys(events).sort()).toEqual(
      ['Interrupt', 'PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    )
    const start = (events.SessionStart[0].hooks ?? [])[0] as { command: string; timeout: number }
    const interrupt = (events.Interrupt[0].hooks ?? [])[0] as { command: string; timeout: number }
    expect(interrupt.command).toBe(start.command.replace(/session-start$/, 'session-start')) // same cfg kind
    expect(start.command.endsWith('sink.js session-start')).toBe(true)
    // Codex clamps SessionEnd/Interrupt to 3s — we set 3 so no startup warning.
    expect(interrupt.timeout).toBe(3)
    expect((events.SessionEnd[0].hooks ?? [])[0].timeout).toBe(3)
  })
})

describe('findNodePath', () => {
  it('resolves node.exe from a PATH-style string, forward-slashed; absent otherwise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'petween-cxnode-'))
    try {
      await writeFile(join(dir, 'node.exe'), '', 'utf8')
      const found = findNodePath(`C:\\definitely-not-here;${dir}`)
      expect(found).not.toBeNull()
      expect(found!.replace(/\\/g, '/')).toBe(join(dir, 'node.exe').replace(/\\/g, '/'))
      expect(findNodePath(undefined)).toBeNull()
      expect(findNodePath('')).toBeNull()
      expect(findNodePath('C:\\definitely-not-here')).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('classifyCodexToolKind', () => {
  it('classifies by the real tool_name (Codex-native + CC aliases), unknown falls to other', () => {
    expect(classifyCodexToolKind('apply_patch')).toBe('pre-tool-edit')
    expect(classifyCodexToolKind('write_file')).toBe('pre-tool-edit')
    expect(classifyCodexToolKind('Write')).toBe('pre-tool-edit')
    expect(classifyCodexToolKind('MultiEdit')).toBe('pre-tool-edit')
    expect(classifyCodexToolKind('shell')).toBe('pre-tool-command')
    expect(classifyCodexToolKind('Bash')).toBe('pre-tool-command')
    expect(classifyCodexToolKind('local_shell')).toBe('pre-tool-command')
    expect(classifyCodexToolKind('read_file')).toBe('pre-tool-other')
    expect(classifyCodexToolKind('grep')).toBe('pre-tool-other')
    expect(classifyCodexToolKind('WebSearch')).toBe('pre-tool-other')
    expect(classifyCodexToolKind(undefined)).toBe('pre-tool-other')
  })
})

describe('install', () => {
  it('creates the hooks key on a fresh hooks.json, preserving unrelated keys', async () => {
    const initial = JSON.stringify({ $schema: 'https://codex.example/schema.json' })
    await withTempConfig(initial, async (hooksPath) => {
      await installCodexHooks(paths(hooksPath))
      const config = JSON.parse(await readFile(hooksPath, 'utf8'))
      expect(config.$schema).toBe('https://codex.example/schema.json')
      expect(Object.keys(config.hooks)).toContain('PreToolUse')
      expect(await codexHooksInstalled(paths(hooksPath))).toBe(true)
    })
  })

  it('preserves foreign hooks (deja-vu style string commands) and merges alongside', async () => {
    const initial = JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash|apply_patch', hooks: [{ type: 'command', command: 'deja.exe hook-tool', statusMessage: '…', timeout: 10 }] },
        ],
        SessionStart: [
          { hooks: [{ type: 'command', command: 'deja.exe hook-context', timeout: 10 }] },
        ],
      },
    })
    await withTempConfig(initial, async (hooksPath) => {
      await installCodexHooks(paths(hooksPath))
      const config = JSON.parse(await readFile(hooksPath, 'utf8'))
      const pre = config.hooks.PreToolUse
      expect(pre).toHaveLength(2) // 1 foreign + our single bare group
      expect(pre[0].matcher).toBe('Bash|apply_patch')
      expect(pre[0].hooks[0].command).toBe('deja.exe hook-tool')
      const start = config.hooks.SessionStart
      expect(start).toHaveLength(2)
      expect(start[0].hooks[0].command).toBe('deja.exe hook-context')
    })
  })

  it('reinstall is idempotent; uninstall removes ours precisely and drops the backup', async () => {
    await withTempConfig(null, async (hooksPath) => {
      await installCodexHooks(paths(hooksPath))
      await installCodexHooks(paths(hooksPath))
      let config = JSON.parse(await readFile(hooksPath, 'utf8'))
      expect(config.hooks.PreToolUse).toHaveLength(1)
      expect(config.hooks.Interrupt).toHaveLength(1)
      expect(await readFile(`${hooksPath}.petween-bak`, 'utf8')).toBeDefined()

      const removed = await uninstallCodexHooks(paths(hooksPath))
      expect(removed).toBe(true)
      config = JSON.parse(await readFile(hooksPath, 'utf8'))
      expect(config.hooks).toBeUndefined() // nothing foreign remained
      await expect(readFile(`${hooksPath}.petween-bak`, 'utf8')).rejects.toThrow()
    })
  })

  it('refuses corrupt files and malformed values without touching them', async () => {
    await withTempConfig('{ not json', async (hooksPath) => {
      await expect(installCodexHooks(paths(hooksPath))).rejects.toThrow(/not valid JSON/)
      expect(await readFile(hooksPath, 'utf8')).toBe('{ not json')
    })
    await withTempConfig(JSON.stringify({ hooks: { Stop: 'oops' } }), async (hooksPath) => {
      await expect(installCodexHooks(paths(hooksPath))).rejects.toThrow(/hooks.Stop.*not an array/)
    })
    await withTempConfig(JSON.stringify({ hooks: 'oops' }), async (hooksPath) => {
      await expect(installCodexHooks(paths(hooksPath))).rejects.toThrow(/hooks is not an object/)
    })
  })

  it('serializes concurrent install/uninstall — the config never interleaves', async () => {
    await withTempConfig(null, async (hooksPath) => {
      await Promise.all([installCodexHooks(paths(hooksPath)), uninstallCodexHooks(paths(hooksPath))])
      JSON.parse(await readFile(hooksPath, 'utf8')) // still valid
      expect(await codexHooksInstalled(paths(hooksPath))).toBe(false)
    })
  })

  it('a foreign command merely mentioning a sibling of our cfg dir is never ours (exact-path ownership)', async () => {
    const sibling = `${CFG_DIR}.bak/stop.cfg`
    const initial = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `curl.exe --config "${sibling}" --data-binary @-`, timeout: 5 }] }] },
    })
    await withTempConfig(initial, async (hooksPath) => {
      await installCodexHooks(paths(hooksPath))
      await uninstallCodexHooks(paths(hooksPath))
      const config = JSON.parse(await readFile(hooksPath, 'utf8'))
      expect(config.hooks.Stop).toHaveLength(1)
      expect(config.hooks.Stop[0].hooks[0].command).toContain(sibling)
    })
  })

  it('reinstall filters STALE pre-v0.6.2 groups pointing at retired cfg names (no accumulation)', async () => {
    // Real-machine report: the old three-matcher PreToolUse groups referenced
    // pre-tool-edit/command.cfg — without the legacy names in the ownership
    // set they survived every reinstall and accumulated.
    const stale = (kind: string, matcher?: string) => ({
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [{ type: 'command', command: `curl.exe --config "${CFG_DIR}/${kind}.cfg" --data-binary @-`, timeout: 5 }],
    })
    const initial = JSON.stringify({
      hooks: {
        PreToolUse: [
          stale('pre-tool-edit', 'apply_patch|write_file|Edit|Write|MultiEdit|NotebookEdit'),
          stale('pre-tool-command', 'shell|Bash'),
          stale('pre-tool-other'),
        ],
      },
    })
    await withTempConfig(initial, async (hooksPath) => {
      await installCodexHooks(paths(hooksPath))
      const config = JSON.parse(await readFile(hooksPath, 'utf8'))
      expect(config.hooks.PreToolUse).toHaveLength(1) // all three stale groups replaced by the single bare one
      expect(config.hooks.PreToolUse[0].matcher).toBeUndefined()
    })
  })
})
