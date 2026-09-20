/**
 * cc hooks wiring: curl cfg rendering/port rewrite, the settings.json hooks
 * shape (event → matcher groups → exec-form hooks), and the merge-install /
 * precise-uninstall contract against the Claude Code user config (foreign
 * content — env with secrets, model, Pebrel-style hooks — must survive
 * untouched; corrupt files must not be clobbered).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCcHookEvents,
  installCcHooks,
  renderCcCurlConfig,
  uninstallCcHooks,
  writeCcHookConfigs,
  ccHooksInstalled,
  CC_EVENT_PATH,
} from '../../src/main/connectors/cc-hooks'

const CFG_DIR = 'C:/Users/t/AppData/Roaming/petween-desktop/cc-hooks'

function paths(settingsPath: string): { cfgDir: string; settingsPath: string } {
  return { cfgDir: CFG_DIR, settingsPath }
}

async function withTempConfig<T>(
  initial: string | null,
  run: (settingsPath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'petween-cchooks-'))
  try {
    const settingsPath = join(dir, 'settings.json')
    if (initial !== null) await writeFile(settingsPath, initial, 'utf8')
    return await run(settingsPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('cfg rendering', () => {
  it('renders a POST cfg with the port, endpoint, kind and loopback guards', () => {
    const cfg = renderCcCurlConfig(51401, 'pre-tool-edit')
    expect(cfg).toContain('request = "POST"')
    expect(cfg).toContain(`url = "http://127.0.0.1:51401${CC_EVENT_PATH}?e=pre-tool-edit"`)
    expect(cfg).toContain('connect-timeout = 1')
    expect(cfg).toContain('max-time = 2')
    expect(cfg).toContain('noproxy = "*"')
  })

  it('writeCcHookConfigs writes one file per kind with the fresh port', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'petween-cccfg-'))
    try {
      await writeCcHookConfigs(dir, 11111)
      const events = buildCcHookEvents(dir)
      const hooks = Object.values(events).flat().flatMap((group) => group.hooks ?? [])
      for (const hook of hooks) {
        const args = hook.args as string[]
        const cfgFile = args[1]
        const content = await readFile(cfgFile, 'utf8')
        expect(content).toContain(':11111')
      }
      // A later boot rewrites with the new port.
      await writeCcHookConfigs(dir, 22222)
      const first = await readFile(join(dir, 'session-start.cfg'), 'utf8')
      expect(first).toContain(':22222')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('buildCcHookEvents', () => {
  it('uses exec-form curl hooks with the cfg path, stdin forwarding and SECONDS timeout', () => {
    const events = buildCcHookEvents(CFG_DIR)
    const pre = events.PreToolUse
    expect(pre).toHaveLength(3)
    expect(pre.map((group) => group.matcher)).toEqual([
      'Edit|Write|MultiEdit|NotebookEdit',
      'Bash',
      '^(?!(?:Edit|Write|MultiEdit|NotebookEdit|Bash)$)',
    ])
    for (const group of pre) {
      const hook = (group.hooks ?? [])[0] as Record<string, unknown>
      expect(hook.type).toBe('command')
      expect(hook.command).toBe('curl.exe')
      expect(hook.timeout).toBe(5) // CC timeout unit is seconds
      const args = hook.args as string[]
      expect(args[0]).toBe('--config')
      expect(args[1].startsWith(`${CFG_DIR}/`)).toBe(true)
      expect(args[2]).toBe('--data-binary')
      expect(args[3]).toBe('@-')
    }
  })

  it('covers the CC event surface; failure shares the post-tool cfg, notification shares permission', () => {
    const events = buildCcHookEvents(CFG_DIR)
    expect(Object.keys(events).sort()).toEqual(
      [
        'Notification',
        'PermissionRequest',
        'PostToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'UserPromptSubmit',
      ].sort(),
    )
    const post = (events.PostToolUse[0].hooks ?? [])[0] as { args: string[] }
    const failure = (events.PostToolUseFailure[0].hooks ?? [])[0] as { args: string[] }
    expect(post.args[1]).toBe(failure.args[1])
    const permission = (events.PermissionRequest[0].hooks ?? [])[0] as { args: string[] }
    const notification = (events.Notification[0].hooks ?? [])[0] as { args: string[] }
    expect(permission.args[1]).toBe(notification.args[1])
    expect(events.SessionEnd[0].matcher).toBeUndefined()
  })
})

describe('install', () => {
  it('creates the hooks key on a fresh settings.json, preserving unrelated keys', async () => {
    const initial = JSON.stringify({ model: 'fable', env: { FOO: 'bar' } })
    await withTempConfig(initial, async (settingsPath) => {
      await installCcHooks(paths(settingsPath))
      const config = JSON.parse(await readFile(settingsPath, 'utf8'))
      expect(config.model).toBe('fable')
      expect(config.env.FOO).toBe('bar')
      expect(Object.keys(config.hooks)).toContain('PreToolUse')
      expect(await ccHooksInstalled(paths(settingsPath))).toBe(true)
    })
  })

  it('preserves foreign hooks (Pebrel-style exec entries) and unrelated top-level keys', async () => {
    const initial = JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: 'secret' },
      model: 'fable',
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'D:/Pebrel/runtime/pebrel-hook.exe', args: ['claude'], timeout: 10 }] },
        ],
        PreToolUse: [{ matcher: '^Read$', hooks: [{ type: 'command', command: 'echo read' }] }],
      },
    })
    await withTempConfig(initial, async (settingsPath) => {
      await installCcHooks(paths(settingsPath))
      const config = JSON.parse(await readFile(settingsPath, 'utf8'))
      expect(config.env.ANTHROPIC_AUTH_TOKEN).toBe('secret')
      const start = config.hooks.SessionStart
      expect(start).toHaveLength(2) // foreign + ours
      expect(start[0].hooks[0].command).toBe('D:/Pebrel/runtime/pebrel-hook.exe')
      const pre = config.hooks.PreToolUse
      expect(pre).toHaveLength(4) // 1 foreign + 3 ours
      expect(pre[0].matcher).toBe('^Read$')
    })
  })

  it('reinstall is idempotent (our entries replaced, not duplicated)', async () => {
    await withTempConfig(null, async (settingsPath) => {
      await installCcHooks(paths(settingsPath))
      await installCcHooks(paths(settingsPath))
      const config = JSON.parse(await readFile(settingsPath, 'utf8'))
      expect(config.hooks.PreToolUse).toHaveLength(3)
      expect(config.hooks.PermissionRequest).toHaveLength(1)
    })
  })

  it('refuses to touch a corrupt settings file', async () => {
    await withTempConfig('{ not json', async (settingsPath) => {
      await expect(installCcHooks(paths(settingsPath))).rejects.toThrow(/not valid JSON/)
      expect(await readFile(settingsPath, 'utf8')).toBe('{ not json')
    })
  })

  it('refuses a malformed (non-array) event value instead of silently dropping it', async () => {
    const initial = JSON.stringify({ hooks: { Stop: 'oops' } })
    await withTempConfig(initial, async (settingsPath) => {
      await expect(installCcHooks(paths(settingsPath))).rejects.toThrow(/hooks.Stop.*not an array/)
      expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual(JSON.parse(initial))
    })
  })

  it('leaves a .petween-bak backup of the previous config on every rewrite', async () => {
    await withTempConfig(null, async (settingsPath) => {
      await installCcHooks(paths(settingsPath))
      const first = JSON.parse(await readFile(settingsPath, 'utf8'))
      first.hooks.Stop = [...first.hooks.Stop, { hooks: [{ type: 'command', command: 'echo x' }] }]
      await writeFile(settingsPath, JSON.stringify(first), 'utf8')

      await installCcHooks(paths(settingsPath)) // reinstall → rewrite → backup
      const bak = JSON.parse(await readFile(`${settingsPath}.petween-bak`, 'utf8'))
      expect(bak.hooks.Stop).toHaveLength(2) // the pre-rewrite generation
    })
  })

  it('serializes concurrent install/uninstall — the config never interleaves', async () => {
    await withTempConfig(null, async (settingsPath) => {
      await Promise.all([installCcHooks(paths(settingsPath)), uninstallCcHooks(paths(settingsPath))])
      const config = JSON.parse(await readFile(settingsPath, 'utf8')) // still valid JSON
      expect(await ccHooksInstalled(paths(settingsPath))).toBe(false) // chain order: install → uninstall
    })
  })
})

describe('uninstall', () => {
  it('removes our entries, keeps foreign ones', async () => {
    await withTempConfig(null, async (settingsPath) => {
      await installCcHooks(paths(settingsPath))
      const installed = JSON.parse(await readFile(settingsPath, 'utf8'))
      const foreign = { hooks: [{ type: 'command', command: 'echo keep-me' }] }
      installed.hooks.Stop = [...installed.hooks.Stop, foreign]
      await writeFile(settingsPath, JSON.stringify(installed), 'utf8')

      const removed = await uninstallCcHooks(paths(settingsPath))
      expect(removed).toBe(true)
      const config = JSON.parse(await readFile(settingsPath, 'utf8'))
      expect(config.hooks.Stop).toEqual([foreign])
      expect(config.hooks.PreToolUse).toBeUndefined() // only ours there → key gone
      expect(await ccHooksInstalled(paths(settingsPath))).toBe(false)
    })
  })

  it('drops the hooks key entirely when nothing remains', async () => {
    const initial = JSON.stringify({ model: 'fable' })
    await withTempConfig(initial, async (settingsPath) => {
      await installCcHooks(paths(settingsPath))
      await uninstallCcHooks(paths(settingsPath))
      const config = JSON.parse(await readFile(settingsPath, 'utf8'))
      expect(config.hooks).toBeUndefined()
      expect(config.model).toBe('fable')
    })
  })

  it('missing settings or absent hooks report nothing removed', async () => {
    await withTempConfig(null, async (settingsPath) => {
      expect(await uninstallCcHooks(paths(settingsPath))).toBe(false)
      await writeFile(settingsPath, JSON.stringify({ env: {} }), 'utf8')
      expect(await uninstallCcHooks(paths(settingsPath))).toBe(false)
      expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({ env: {} })
    })
  })

  it('leaves a user copy of our hooks parked under a sibling cfg dir alone (exact-path ownership)', async () => {
    // Regression shape (v0.4.0 hardening): ownership is the exact cfg file
    // paths, never a directory prefix — a cc-hooks.bak/<kind>.cfg arg is foreign.
    const sibling = `${CFG_DIR}.bak/stop.cfg`
    const entry = { hooks: [{ type: 'command', command: 'curl.exe', args: ['--config', sibling, '--data-binary', '@-'], timeout: 5 }] }
    await withTempConfig(JSON.stringify({ hooks: { Stop: [entry] } }), async (settingsPath) => {
      await installCcHooks(paths(settingsPath))
      await uninstallCcHooks(paths(settingsPath))
      const config = JSON.parse(await readFile(settingsPath, 'utf8'))
      expect(config.hooks.Stop).toHaveLength(1) // the sibling-dir entry survived both passes
      expect(config.hooks.Stop[0].hooks[0].args[1]).toBe(sibling)
    })
  })
})
