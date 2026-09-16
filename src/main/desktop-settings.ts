/**
 * desktop-settings.ts — the shell-owned settings store (desktop-settings.json
 * under userData; petween's config is never touched). Pure Node: the path is
 * injected, writes are debounced, invalid fields clamp to defaults.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type ClickThroughMode = 'auto' | 'always-through' | 'always-interactive'

export interface DesktopSettings {
  clickThrough: {
    /** auto = hit-test + cursor poll; the other two are stuck-state escapes. */
    mode: ClickThroughMode
    /** Extra hit margin around the pet body rect (px, DIP). */
    hitPaddingPx: number
    /** forward:true lets the renderer see mousemove while click-through;
     *  off = poll-only (also avoids the #35030 foreign-drag interference). */
    forwardMouseMoves: boolean
    /** Periodic + event-driven re-asserts of setIgnoreMouseEvents. */
    selfHealing: boolean
    /** Global rescue hotkey (toggle interactive lock). */
    rescueHotkeyEnabled: boolean
  }
  dsh: {
    enabled: boolean
    port: number
  }
  /**
   * Companion enable map (docs/05 Phase 8): absent id = enabled, explicit
   * false disables. The compile-time registry provides ids/display names.
   */
  companions: {
    enabled: Record<string, boolean>
  }
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  clickThrough: {
    mode: 'auto',
    hitPaddingPx: 6,
    forwardMouseMoves: true,
    selfHealing: true,
    rescueHotkeyEnabled: true,
  },
  dsh: {
    enabled: true,
    port: 3080,
  },
  companions: {
    enabled: {},
  },
}

const HIT_PADDING_MIN = 0
const HIT_PADDING_MAX = 24
const PORT_MIN = 1
const PORT_MAX = 65_535

const MODES: readonly ClickThroughMode[] = ['auto', 'always-through', 'always-interactive']

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback
}

/**
 * Merge-Validates a partial/persisted shape onto the defaults; unknown keys drop.
 *
 * `persisted: true` (loading from disk) demotes 'always-interactive' back to
 * 'auto': that mode makes the full-screen overlay swallow EVERY mouse click
 * in the OS, so it must never survive an app restart — an user who quit in
 * that state would boot into a machine they cannot click (2026-09-16
 * incident). Live updates keep it (the settings UI toggle must work).
 */
export function normalizeDesktopSettings(input: unknown, options: { persisted?: boolean } = {}): DesktopSettings {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const ct = (typeof raw.clickThrough === 'object' && raw.clickThrough !== null ? raw.clickThrough : {}) as Record<string, unknown>
  const dsh = (typeof raw.dsh === 'object' && raw.dsh !== null ? raw.dsh : {}) as Record<string, unknown>
  const companions = (typeof raw.companions === 'object' && raw.companions !== null ? raw.companions : {}) as Record<string, unknown>
  const enabled = (typeof companions.enabled === 'object' && companions.enabled !== null ? companions.enabled : {}) as Record<string, unknown>
  const enabledMap: Record<string, boolean> = {}
  for (const [id, value] of Object.entries(enabled)) {
    if (typeof value === 'boolean') enabledMap[id] = value
  }
  let mode = MODES.includes(ct.mode as ClickThroughMode) ? (ct.mode as ClickThroughMode) : 'auto'
  if (options.persisted === true && mode === 'always-interactive') mode = 'auto'
  return {
    clickThrough: {
      mode,
      hitPaddingPx: clampNumber(ct.hitPaddingPx, HIT_PADDING_MIN, HIT_PADDING_MAX, DEFAULT_DESKTOP_SETTINGS.clickThrough.hitPaddingPx),
      forwardMouseMoves:
        typeof ct.forwardMouseMoves === 'boolean' ? ct.forwardMouseMoves : true,
      selfHealing: typeof ct.selfHealing === 'boolean' ? ct.selfHealing : true,
      rescueHotkeyEnabled:
        typeof ct.rescueHotkeyEnabled === 'boolean' ? ct.rescueHotkeyEnabled : true,
    },
    dsh: {
      enabled: typeof dsh.enabled === 'boolean' ? dsh.enabled : true,
      port: clampNumber(dsh.port, PORT_MIN, PORT_MAX, DEFAULT_DESKTOP_SETTINGS.dsh.port),
    },
    companions: { enabled: enabledMap },
  }
}

export interface DesktopSettingsStore {
  get(): DesktopSettings
  /** Validates + persists (debounced) + notifies listeners; returns the fresh value. */
  update(patch: unknown): DesktopSettings
  onChange(listener: (settings: DesktopSettings) => void): () => void
  /** Flush a pending debounced write (app quit). */
  flush(): Promise<void>
}

const WRITE_DEBOUNCE_MS = 250

export async function createDesktopSettingsStore(filePath: string): Promise<DesktopSettingsStore> {
  let settings: DesktopSettings = DEFAULT_DESKTOP_SETTINGS
  try {
    settings = normalizeDesktopSettings(JSON.parse(await readFile(filePath, 'utf8')), { persisted: true })
  } catch {
    // missing or corrupt file: defaults (first boot)
  }

  const listeners = new Set<(settings: DesktopSettings) => void>()
  let writeTimer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> = Promise.resolve()

  const persist = (): void => {
    if (writeTimer !== null) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      writing = writeFile(filePath, JSON.stringify(settings, null, 2), 'utf8').catch(async () => {
        // First write into a fresh data dir: create parents, retry once.
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, JSON.stringify(settings, null, 2), 'utf8')
      })
    }, WRITE_DEBOUNCE_MS)
  }

  return {
    get: () => settings,
    update(patch) {
      // The patch may be a full document or a partial one — deep-merge at the
      // known section levels, then validate.
      const merged = {
        ...(settings as unknown as Record<string, unknown>),
        ...(typeof patch === 'object' && patch !== null ? (patch as Record<string, unknown>) : {}),
        clickThrough: {
          ...(settings.clickThrough as unknown as Record<string, unknown>),
          ...((patch as { clickThrough?: Record<string, unknown> })?.clickThrough ?? {}),
        },
        dsh: {
          ...(settings.dsh as unknown as Record<string, unknown>),
          ...((patch as { dsh?: Record<string, unknown> })?.dsh ?? {}),
        },
        companions: {
          ...(settings.companions as unknown as Record<string, unknown>),
          ...((patch as { companions?: Record<string, unknown> })?.companions ?? {}),
        },
      }
      settings = normalizeDesktopSettings(merged)
      persist()
      for (const listener of listeners) listener(settings)
      return settings
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async flush() {
      if (writeTimer !== null) {
        clearTimeout(writeTimer)
        writeTimer = null
        writing = writeFile(filePath, JSON.stringify(settings, null, 2), 'utf8').catch(async () => {
          await mkdir(dirname(filePath), { recursive: true })
          await writeFile(filePath, JSON.stringify(settings, null, 2), 'utf8')
        })
      }
      await writing
    },
  }
}
