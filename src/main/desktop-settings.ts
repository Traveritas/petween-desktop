/**
 * desktop-settings.ts — the shell-owned settings store (desktop-settings.json
 * under userData; petween's config is never touched). Pure Node: the path is
 * injected, writes are debounced, invalid fields clamp to defaults.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ClickThroughMode } from './pointer-through-logic'

export type { ClickThroughMode }

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
   * `options` is a per-companion bag the shell stores verbatim — each
   * companion validates its own keys (Phase 10: the stats HUD's style /
   * animation picks live here).
   */
  companions: {
    enabled: Record<string, boolean>
    options: Record<string, Record<string, unknown>>
  }
  /**
   * Agent connectors beyond DSH (docs/06): the zcode hooks listener. `enabled`
   * gates the event sink only — hook installation into the zcode config is an
   * explicit user action from the settings card. `followLatestUser` = follow
   * mode: with several zcode sessions open, the pet tracks only the one the
   * user last submitted a prompt in (background sessions stay bookkept but
   * silent).
   */
  connectors: {
    zcode: {
      enabled: boolean
      followLatestUser: boolean
    }
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
    options: {},
  },
  connectors: {
    zcode: {
      enabled: true,
      followLatestUser: false,
    },
  },
}

const HIT_PADDING_MIN = 0
const HIT_PADDING_MAX = 24
const PORT_MIN = 1
const PORT_MAX = 65_535

const MODES: readonly ClickThroughMode[] = ['auto', 'always-through']

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback
}

/**
 * Merge-Validates a partial/persisted shape onto the defaults; unknown keys drop.
 * 'always-interactive' was removed 2026-09-16 (user decision — it swallowed
 * every OS mouse click); any persisted/live occurrence normalizes to 'auto'.
 */
export function normalizeDesktopSettings(input: unknown): DesktopSettings {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const ct = (typeof raw.clickThrough === 'object' && raw.clickThrough !== null ? raw.clickThrough : {}) as Record<string, unknown>
  const dsh = (typeof raw.dsh === 'object' && raw.dsh !== null ? raw.dsh : {}) as Record<string, unknown>
  const companions = (typeof raw.companions === 'object' && raw.companions !== null ? raw.companions : {}) as Record<string, unknown>
  const enabled = (typeof companions.enabled === 'object' && companions.enabled !== null ? companions.enabled : {}) as Record<string, unknown>
  const enabledMap: Record<string, boolean> = {}
  for (const [id, value] of Object.entries(enabled)) {
    if (typeof value === 'boolean') enabledMap[id] = value
  }
  const rawOptions = (typeof companions.options === 'object' && companions.options !== null ? companions.options : {}) as Record<string, unknown>
  const optionsMap: Record<string, Record<string, unknown>> = {}
  for (const [id, value] of Object.entries(rawOptions)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      optionsMap[id] = value as Record<string, unknown>
    }
  }
  const connectors = (typeof raw.connectors === 'object' && raw.connectors !== null ? raw.connectors : {}) as Record<string, unknown>
  const zcode = (typeof connectors.zcode === 'object' && connectors.zcode !== null ? connectors.zcode : {}) as Record<string, unknown>
  const mode = MODES.includes(ct.mode as ClickThroughMode) ? (ct.mode as ClickThroughMode) : 'auto'
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
    companions: { enabled: enabledMap, options: optionsMap },
    connectors: {
      zcode: {
        enabled: typeof zcode.enabled === 'boolean' ? zcode.enabled : true,
        followLatestUser: typeof zcode.followLatestUser === 'boolean' ? zcode.followLatestUser : false,
      },
    },
  }
}

export interface DesktopSettingsStore {
  get(): DesktopSettings
  /** Validates + persists (debounced) + notifies listeners; returns the fresh value. */
  update(patch: unknown): DesktopSettings
  onChange(listener: (settings: DesktopSettings) => void): () => void
  /** Flush a pending debounced write (async). */
  flush(): Promise<void>
  /**
   * Synchronous flush for the quit path — Electron's quit handler cannot
   * await, and an un-drained debounce window would drop the last change
   * (2026-09-16 review finding). The file is tiny; writes are rare.
   */
  flushSync(): void
}

const WRITE_DEBOUNCE_MS = 250

export async function createDesktopSettingsStore(filePath: string): Promise<DesktopSettingsStore> {
  let settings: DesktopSettings = DEFAULT_DESKTOP_SETTINGS
  try {
    settings = normalizeDesktopSettings(JSON.parse(await readFile(filePath, 'utf8')))
  } catch {
    // missing or corrupt file: defaults (first boot)
  }

  const listeners = new Set<(settings: DesktopSettings) => void>()
  let writeTimer: ReturnType<typeof setTimeout> | null = null
  // Writes always CHAIN (never replace the in-flight promise): a flush racing
  // a just-fired debounce must not let an older writeFile land after a newer
  // one and persist stale content.
  let writing: Promise<void> = Promise.resolve()

  const serialize = (): string => JSON.stringify(settings, null, 2)

  const writeNow = (): Promise<void> => {
    const content = serialize()
    const attempt = async (): Promise<void> => {
      try {
        await writeFile(filePath, content, 'utf8')
      } catch {
        // First write into a fresh data dir: create parents, retry once.
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, content, 'utf8')
      }
    }
    writing = writing.then(attempt, attempt)
    return writing
  }

  const persist = (): void => {
    if (writeTimer !== null) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      void writeNow()
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
          // options merges per companion id: patching one companion's bag
          // must not drop another companion's (physics, stats HUD, …).
          options: {
            ...(settings.companions.options as unknown as Record<string, unknown>),
            ...((patch as { companions?: { options?: Record<string, unknown> } })?.companions?.options ?? {}),
          },
        },
        connectors: {
          ...(settings.connectors as unknown as Record<string, unknown>),
          ...((patch as { connectors?: Record<string, unknown> })?.connectors ?? {}),
          zcode: {
            ...(settings.connectors.zcode as unknown as Record<string, unknown>),
            ...((patch as { connectors?: { zcode?: Record<string, unknown> } })?.connectors?.zcode ?? {}),
          },
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
        await writeNow()
        return
      }
      await writing
    },
    flushSync() {
      if (writeTimer !== null) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
      const content = serialize()
      try {
        writeFileSync(filePath, content, 'utf8')
      } catch {
        try {
          mkdirSync(dirname(filePath), { recursive: true })
          writeFileSync(filePath, content, 'utf8')
        } catch (error) {
          console.error('[petween-desktop] settings flushSync failed', error)
        }
      }
    },
  }
}
