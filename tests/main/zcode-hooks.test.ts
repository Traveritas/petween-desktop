/**
 * zcode hooks wiring: curl cfg rendering/port rewrite, the hooks.events shape,
 * and the merge-install / precise-uninstall contract against the zcode user
 * config (foreign content must survive untouched; corrupt files must not be
 * clobbered).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildZcodeHookEvents,
  installZcodeHooks,
  renderZcodeCurlConfig,
  uninstallZcodeHooks,
  writeZcodeHookConfigs,
  zcodeHooksInstalled,
  ZCODE_EVENT_PATH,
} from '../../src/main/connectors/zcode-hooks'

const CFG_DIR = 'C:/Users/t/AppData/Roaming/petween-desktop/zcode-hooks'

function paths(configPath: string): { cfgDir: string; zcodeConfigPath: string } {
  return { cfgDir: CFG_DIR, zcodeConfigPath: configPath }
}

async function withTempConfig<T>(
  initial: string | null,
  run: (configPath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'petween-zhooks-'))
  try {
    const configPath = join(dir, 'config.json')
    if (initial !== null) await writeFile(configPath, initial, 'utf8')
    return await run(configPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('cfg rendering', () => {
  it('renders a POST cfg with the port, endpoint, kind and loopback guards', () => {
    const cfg = renderZcodeCurlConfig(51401, 'pre-tool-edit')
    expect(cfg).toContain('request = "POST"')
    expect(cfg).toContain(`url = "http://127.0.0.1:51401${ZCODE_EVENT_PATH}?e=pre-tool-edit"`)
    expect(cfg).toContain('connect-timeout = 1')
    expect(cfg).toContain('max-time = 2')
    expect(cfg).toContain('noproxy = "*"')
  })

  it('writeZcodeHookConfigs writes one file per kind with the fresh port', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'petween-zcfg-'))
    try {
      await writeZcodeHookConfigs(dir, 11111)
      const events = buildZcodeHookEvents(dir)
      const kinds = Object.values(events).flat().flatMap((group) => group.hooks ?? [])
      for (const hook of kinds) {
        const args = hook.args as string[]
        const cfgFile = args[1]
        const content = await readFile(cfgFile, 'utf8')
        expect(content).toContain(':11111')
      }
      // A later boot rewrites with the new port.
      await writeZcodeHookConfigs(dir, 22222)
      const first = await readFile(join(dir, 'session-start.cfg'), 'utf8')
      expect(first).toContain(':22222')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('buildZcodeHookEvents', () => {
  it('uses process-type curl hooks with the cfg path and stdin forwarding', () => {
    const events = buildZcodeHookEvents(CFG_DIR)
    const pre = events.PreToolUse
    expect(pre).toHaveLength(3)
    expect(pre.map((group) => group.matcher)).toEqual(['^(Edit|Write|ApplyPatch)$', '^Bash$', '^(?!(?:Edit|Write|ApplyPatch|Bash)$)'])
    for (const group of pre) {
      const hook = (group.hooks ?? [])[0] as Record<string, unknown>
      expect(hook.type).toBe('process')
      expect(hook.command).toBe('curl.exe')
      expect(hook.timeoutMs).toBe(2500)
      const args = hook.args as string[]
      expect(args[0]).toBe('--config')
      expect(args[1].startsWith(`${CFG_DIR}/`)).toBe(true)
      // Phase 10: the hook body is zcode's stdin JSON forwarded verbatim —
      // session id and tool payload come from the JSON (docs/06 §8).
      expect(args[2]).toBe('--data-binary')
      expect(args[3]).toBe('@-')
    }
  })

  it('covers all seven zcode events; failure shares the post-tool cfg', () => {
    const events = buildZcodeHookEvents(CFG_DIR)
    expect(Object.keys(events).sort()).toEqual(
      ['PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    )
    const post = (events.PostToolUse[0].hooks ?? [])[0] as { args: string[] }
    const failure = (events.PostToolUseFailure[0].hooks ?? [])[0] as { args: string[] }
    expect(post.args[1]).toBe(failure.args[1])
  })
})

describe('install', () => {
  it('creates the config with hooks.enabled on a fresh install', async () => {
    await withTempConfig(null, async (configPath) => {
      await installZcodeHooks(paths(configPath))
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      expect(config.hooks.enabled).toBe(true)
      expect(Object.keys(config.hooks.events)).toContain('PreToolUse')
      expect(await zcodeHooksInstalled(paths(configPath))).toBe(true)
    })
  })

  it('preserves foreign hooks, other events and unrelated top-level keys', async () => {
    const initial = JSON.stringify({
      mcp: { servers: { mine: { command: 'node' } } },
      hooks: {
        enabled: true,
        events: {
          Stop: [{ hooks: [{ type: 'command', command: 'echo foreign' }] }],
          PreToolUse: [{ matcher: '^Read$', hooks: [{ type: 'command', command: 'echo read' }] }],
        },
      },
    })
    await withTempConfig(initial, async (configPath) => {
      await installZcodeHooks(paths(configPath))
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      expect(config.mcp.servers.mine.command).toBe('node')
      const stop = config.hooks.events.Stop
      expect(stop).toHaveLength(2)
      expect(stop[0].hooks[0].command).toBe('echo foreign')
      const pre = config.hooks.events.PreToolUse
      expect(pre).toHaveLength(4) // 1 foreign + 3 ours
      expect(pre[0].matcher).toBe('^Read$')
    })
  })

  it('reinstall is idempotent (our entries replaced, not duplicated)', async () => {
    await withTempConfig(null, async (configPath) => {
      await installZcodeHooks(paths(configPath))
      await installZcodeHooks(paths(configPath))
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      expect(config.hooks.events.PreToolUse).toHaveLength(3)
      expect(config.hooks.events.Stop).toHaveLength(1)
    })
  })

  it('refuses to touch a corrupt config', async () => {
    await withTempConfig('{ not json', async (configPath) => {
      await expect(installZcodeHooks(paths(configPath))).rejects.toThrow(/not valid JSON/)
      expect(await readFile(configPath, 'utf8')).toBe('{ not json')
    })
  })
})

describe('uninstall', () => {
  it('removes our entries, keeps foreign ones, and leaves enabled true while foreign hooks remain', async () => {
    // Install first, then splice a foreign Stop entry alongside ours.
    await withTempConfig(null, async (configPath) => {
      await installZcodeHooks(paths(configPath))
      const installed = JSON.parse(await readFile(configPath, 'utf8'))
      const foreign = { hooks: [{ type: 'command', command: 'echo keep-me' }] }
      installed.hooks.events.Stop = [...installed.hooks.events.Stop, foreign]
      await writeFile(configPath, JSON.stringify(installed), 'utf8')

      const removed = await uninstallZcodeHooks(paths(configPath))
      expect(removed).toBe(true)
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      expect(config.hooks.events).toEqual({ Stop: [foreign] })
      expect(config.hooks.enabled).toBe(true) // foreign entries remain — runner stays on
      expect(await zcodeHooksInstalled(paths(configPath))).toBe(false)
    })
  })

  it('a config holding only our entries goes back to enabled:false', async () => {
    await withTempConfig(null, async (configPath) => {
      await installZcodeHooks(paths(configPath))
      await uninstallZcodeHooks(paths(configPath))
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      expect(config.hooks.events).toEqual({})
      expect(config.hooks.enabled).toBe(false)
    })
  })

  it('missing config or absent hooks report nothing removed', async () => {
    await withTempConfig(null, async (configPath) => {
      expect(await uninstallZcodeHooks(paths(configPath))).toBe(false)
      await writeFile(configPath, JSON.stringify({ mcp: {} }), 'utf8')
      expect(await uninstallZcodeHooks(paths(configPath))).toBe(false)
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ mcp: {} })
    })
  })
})
