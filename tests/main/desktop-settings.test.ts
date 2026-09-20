/**
 * Desktop settings store: defaults on first boot, clamping on bad input,
 * partial patches, persistence roundtrip, change notifications.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DESKTOP_SETTINGS,
  createDesktopSettingsStore,
  normalizeDesktopSettings,
} from '../../src/main/desktop-settings'

describe('normalizeDesktopSettings', () => {
  it('returns defaults for garbage input', () => {
    expect(normalizeDesktopSettings(null)).toEqual(DEFAULT_DESKTOP_SETTINGS)
    expect(normalizeDesktopSettings('junk')).toEqual(DEFAULT_DESKTOP_SETTINGS)
    expect(normalizeDesktopSettings({ clickThrough: { mode: 'nope' } }).clickThrough.mode).toBe('auto')
  })

  it('clamps numbers into range', () => {
    const settings = normalizeDesktopSettings({
      clickThrough: { hitPaddingPx: 999 },
      dsh: { port: 0 },
    })
    expect(settings.clickThrough.hitPaddingPx).toBe(24)
    expect(settings.dsh.port).toBeGreaterThan(0)
  })

  it('keeps valid values', () => {
    const settings = normalizeDesktopSettings({
      clickThrough: { mode: 'always-through', hitPaddingPx: 0, forwardMouseMoves: false },
      dsh: { enabled: false, port: 9999 },
    })
    expect(settings.clickThrough.mode).toBe('always-through')
    expect(settings.clickThrough.hitPaddingPx).toBe(0)
    expect(settings.clickThrough.forwardMouseMoves).toBe(false)
    expect(settings.dsh.enabled).toBe(false)
    expect(settings.dsh.port).toBe(9999)
  })

  it('always-interactive is gone: any occurrence normalizes to auto (removed 2026-09-16)', () => {
    // The mode swallowed every OS mouse click; removed per user decision —
    // the momentary rescue-hotkey lock covers the legit stuck-state case.
    expect(normalizeDesktopSettings({ clickThrough: { mode: 'always-interactive' } }).clickThrough.mode).toBe('auto')
    // always-through is the safe direction and may persist.
    expect(normalizeDesktopSettings({ clickThrough: { mode: 'always-through' } }).clickThrough.mode).toBe('always-through')
  })

  it('zcode connector defaults to enabled and normalizes non-boolean input', () => {
    expect(DEFAULT_DESKTOP_SETTINGS.connectors.zcode.enabled).toBe(true)
    expect(normalizeDesktopSettings({}).connectors.zcode.enabled).toBe(true)
    expect(normalizeDesktopSettings({ connectors: { zcode: { enabled: false } } }).connectors.zcode.enabled).toBe(false)
    expect(normalizeDesktopSettings({ connectors: { zcode: { enabled: 'yes' } } }).connectors.zcode.enabled).toBe(true)
    expect(normalizeDesktopSettings({ connectors: 'junk' }).connectors.zcode.enabled).toBe(true)
  })

  it.each(['zcode', 'cc', 'codex'] as const)('%s connector mirrors the group defaults and junk falls back', (key) => {
    expect(DEFAULT_DESKTOP_SETTINGS.connectors[key]).toEqual({ enabled: true, followLatestUser: false })
    expect(normalizeDesktopSettings({ connectors: { [key]: { enabled: false, followLatestUser: true } } }).connectors[key]).toEqual({
      enabled: false,
      followLatestUser: true,
    })
    expect(normalizeDesktopSettings({ connectors: { [key]: 'junk' } }).connectors[key].enabled).toBe(true)
  })

  it('cc connector (Phase 15) mirrors the zcode group and patches stay isolated', async () => {
    expect(DEFAULT_DESKTOP_SETTINGS.connectors.cc).toEqual({ enabled: true, followLatestUser: false })
    expect(normalizeDesktopSettings({ connectors: { cc: { enabled: false, followLatestUser: true } } }).connectors.cc).toEqual({
      enabled: false,
      followLatestUser: true,
    })
    expect(normalizeDesktopSettings({ connectors: { cc: 'junk' } }).connectors.cc.enabled).toBe(true)
    const dir = await mkdtemp(join(tmpdir(), 'petween-dsettings-'))
    try {
      const store = await createDesktopSettingsStore(join(dir, 's.json'))
      store.update({ connectors: { zcode: { enabled: false } } })
      // A zcode-only patch must not touch the cc group.
      const next = store.update({ connectors: { cc: { followLatestUser: true } } })
      expect(next.connectors.zcode.enabled).toBe(false)
      expect(next.connectors.cc).toEqual({ enabled: true, followLatestUser: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('followLatestUser defaults off and a zcode patch keeps the sibling field', async () => {
    expect(DEFAULT_DESKTOP_SETTINGS.connectors.zcode.followLatestUser).toBe(false)
    const dir = await mkdtemp(join(tmpdir(), 'petween-dsettings-'))
    try {
      const store = await createDesktopSettingsStore(join(dir, 's.json'))
      store.update({ connectors: { zcode: { enabled: false } } })
      // A followLatestUser patch must not resurrect the disabled listener.
      const next = store.update({ connectors: { zcode: { followLatestUser: true } } })
      expect(next.connectors.zcode).toEqual({ enabled: false, followLatestUser: true })
      expect(normalizeDesktopSettings({ connectors: { zcode: { followLatestUser: true } } }).connectors.zcode).toEqual({
        enabled: true,
        followLatestUser: true,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('createDesktopSettingsStore', () => {
  it('loads persisted settings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'petween-dsettings-'))
    try {
      const file = join(dir, 'desktop-settings.json')
      await writeFile(file, JSON.stringify({ dsh: { port: 1234 } }))
      const store = await createDesktopSettingsStore(file)
      expect(store.get().dsh.port).toBe(1234)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('update merges partials, notifies, persists, and survives reopen', async () => {
    vi.useFakeTimers()
    const dir = await mkdtemp(join(tmpdir(), 'petween-dsettings-'))
    try {
      const file = join(dir, 'desktop-settings.json')
      const store = await createDesktopSettingsStore(file)
      const seen: number[] = []
      store.onChange((settings) => seen.push(settings.dsh.port))

      const next = store.update({ dsh: { port: 4321 } })
      expect(next.dsh.port).toBe(4321)
      expect(store.get().clickThrough.mode).toBe('auto') // untouched section
      await vi.advanceTimersByTimeAsync(400) // debounce fires
      await store.flush()
      expect(seen).toEqual([4321])

      const persisted = JSON.parse(await readFile(file, 'utf8'))
      expect(persisted.dsh.port).toBe(4321)

      const reopened = await createDesktopSettingsStore(file)
      expect(reopened.get().dsh.port).toBe(4321)
    } finally {
      vi.useRealTimers()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('flushSync cancels the pending debounce and writes synchronously (quit path)', async () => {
    vi.useFakeTimers()
    const dir = await mkdtemp(join(tmpdir(), 'petween-dsettings-'))
    try {
      const file = join(dir, 'nested', 'desktop-settings.json')
      const store = await createDesktopSettingsStore(file)
      store.update({ dsh: { port: 7777 } })
      // NOTE: debounce NOT advanced — this is exactly the quit-window race
      store.flushSync()
      const persisted = JSON.parse(await readFile(file, 'utf8'))
      expect(persisted.dsh.port).toBe(7777)
      // double flush is safe
      expect(() => store.flushSync()).not.toThrow()
    } finally {
      vi.useRealTimers()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('invalid patch fields clamp instead of corrupting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'petween-dsettings-'))
    try {
      const store = await createDesktopSettingsStore(join(dir, 's.json'))
      const next = store.update({ clickThrough: { mode: 'hack', hitPaddingPx: -5 } })
      expect(next.clickThrough.mode).toBe('auto')
      expect(next.clickThrough.hitPaddingPx).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
