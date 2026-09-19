/**
 * pointer-through.ts — the Electron glue around the pure decision logic
 * (docs/04 §2). Owns the IPC channel, the 250ms cursor poll, applying
 * setIgnoreMouseEvents on state change, and the hardening surface:
 *
 *  - settings-driven options (mode / hit padding / mouse forwarding), live
 *    applied without restarting;
 *  - an interactive lock (rescue hotkey / settings button) that overrides
 *    everything — the escape hatch for the known wedge bugs;
 *  - self-healing (docs: electron PR #52631/#52633 pending): re-issue the
 *    native ignore state periodically and after render-process-gone,
 *    power-resume, display changes and drag ends, because the native
 *    message-hook can silently go stale.
 */
import { ipcMain, powerMonitor, screen, type BrowserWindow, type IpcMainEvent } from 'electron'
import {
  decideInteractive,
  type PointerThroughOptions,
  type PointerThroughState,
  type Rect,
  type RendererSignal,
} from './pointer-through-logic'

export const POINTER_SIGNAL_CHANNEL = 'petween:pointer-signal'

const POLL_MS = 250
const SELF_HEAL_INTERVAL_MS = 5_000

function isRect(value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) return false
  const rect = value as Record<string, unknown>
  return (
    typeof rect.x === 'number' && Number.isFinite(rect.x) &&
    typeof rect.y === 'number' && Number.isFinite(rect.y) &&
    typeof rect.width === 'number' && Number.isFinite(rect.width) &&
    typeof rect.height === 'number' && Number.isFinite(rect.height) &&
    rect.width >= 0 && rect.height >= 0
  )
}

function sanitizeSignal(payload: unknown): RendererSignal | null {
  if (typeof payload !== 'object' || payload === null) return null
  const raw = payload as Record<string, unknown>
  if (typeof raw.hoverHit !== 'boolean' || typeof raw.dragging !== 'boolean') return null
  const bodyRect = raw.bodyRect
  return { hoverHit: raw.hoverHit, dragging: raw.dragging, bodyRect: isRect(bodyRect) ? bodyRect : null }
}

export interface PointerThroughHandle {
  /** Live-apply new settings (forces a re-issue so flag changes take effect). */
  updateOptions(next: PointerThroughRuntimeOptions): void
  /** Escape hatch: overrides every mode while on. */
  setInteractiveLock(locked: boolean): void
  toggleInteractiveLock(): boolean
  /** Force a re-issue of the native ignore state right now. */
  fixNow(): void
  dispose(): void
}

/** The logic options plus the glue-only toggles. */
export interface PointerThroughRuntimeOptions extends PointerThroughOptions {
  selfHealing: boolean
  forwardMouseMoves: boolean
}

export function attachPointerThrough(win: BrowserWindow, initial: PointerThroughRuntimeOptions): PointerThroughHandle {
  let options = initial
  let state: PointerThroughState = { interactive: false, bodyRect: null }
  let applied: boolean | null = null
  let signal: RendererSignal | null = null
  let signalAt: number | null = null
  let prevDragging = false
  let interactiveLock = false

  // Captured ONCE: reading `win.webContents` on a destroyed window throws
  // "Object has been destroyed" (the quit-time 'closed' handler runs dispose
  // after the window is gone — the stored reference keeps removeListener
  // working; a destroyed EventEmitter accepts removal fine).
  const webContents = win.webContents

  const apply = (): void => {
    if (win.isDestroyed()) return // quit-time ticks must not touch the dead window
    const target = interactiveLock || state.interactive
    if (applied === target) return
    applied = target
    console.log(`[petween-desktop] pointer-through: ${target ? 'interactive' : 'click-through'}`)
    if (target) win.setIgnoreMouseEvents(false)
    else win.setIgnoreMouseEvents(true, { forward: options.forwardMouseMoves })
  }

  const evaluate = (): void => {
    if (win.isDestroyed()) return
    const cursor = screen.getCursorScreenPoint()
    const bounds = win.getContentBounds()
    state = decideInteractive(
      {
        now: Date.now(),
        signalAt,
        signal,
        cursorScreen: { x: cursor.x, y: cursor.y },
        contentOrigin: { x: bounds.x, y: bounds.y },
      },
      state,
      options,
    )
    apply()
  }

  const reissue = (): void => {
    // Stale native hooks are the root of the wedge bugs: force the next
    // apply to actually call setIgnoreMouseEvents again.
    applied = null
    evaluate()
  }

  const onSignal = (event: IpcMainEvent, payload: unknown): void => {
    if (event.sender !== webContents) return
    const sanitized = sanitizeSignal(payload)
    if (sanitized === null) return
    if (prevDragging && !sanitized.dragging) reissue() // drag end: re-anchor the hit region (#41501 family)
    prevDragging = sanitized.dragging
    signal = sanitized
    signalAt = Date.now()
    evaluate()
  }
  ipcMain.on(POINTER_SIGNAL_CHANNEL, onSignal)

  const onFinishedLoad = (): void => {
    applied = null
    evaluate()
  }
  webContents.on('did-finish-load', onFinishedLoad)

  const onRenderGone = (): void => reissue()
  webContents.on('render-process-gone', onRenderGone)

  const onPowerResume = (): void => reissue()
  powerMonitor.on('resume', onPowerResume)

  const onDisplayMetrics = (): void => reissue()
  screen.on('display-metrics-changed', onDisplayMetrics)
  screen.on('display-added', onDisplayMetrics)
  screen.on('display-removed', onDisplayMetrics)

  const onDevToolsOpened = (): void => {
    console.warn(
      '[petween-desktop] DevTools is open — the transparent overlay stops being transparent and click-through cannot be tested. Detach/close DevTools before verifying.',
    )
  }
  webContents.on('devtools-opened', onDevToolsOpened)

  const timer = setInterval(evaluate, POLL_MS)
  let selfHealTimer: ReturnType<typeof setInterval> | null =
    initial.selfHealing ? setInterval(reissue, SELF_HEAL_INTERVAL_MS) : null
  const syncSelfHeal = (enabled: boolean): void => {
    if (enabled && selfHealTimer === null) selfHealTimer = setInterval(reissue, SELF_HEAL_INTERVAL_MS)
    if (!enabled && selfHealTimer !== null) {
      clearInterval(selfHealTimer)
      selfHealTimer = null
    }
  }
  evaluate() // start click-through with forwarding immediately

  const setInteractiveLock = (locked: boolean): void => {
    if (interactiveLock === locked) return
    interactiveLock = locked
    console.log(`[petween-desktop] pointer-through: rescue lock ${locked ? 'ON (interactive)' : 'off'}`)
    reissue()
  }

  return {
    updateOptions(next) {
      options = next
      syncSelfHeal(next.selfHealing)
      reissue()
    },
    setInteractiveLock,
    toggleInteractiveLock() {
      setInteractiveLock(!interactiveLock)
      return interactiveLock
    },
    fixNow: reissue,
    dispose(): void {
      clearInterval(timer)
      if (selfHealTimer !== null) clearInterval(selfHealTimer)
      ipcMain.removeListener(POINTER_SIGNAL_CHANNEL, onSignal)
      webContents.removeListener('did-finish-load', onFinishedLoad)
      webContents.removeListener('render-process-gone', onRenderGone)
      webContents.removeListener('devtools-opened', onDevToolsOpened)
      powerMonitor.removeListener('resume', onPowerResume)
      screen.removeListener('display-metrics-changed', onDisplayMetrics)
      screen.removeListener('display-added', onDisplayMetrics)
      screen.removeListener('display-removed', onDisplayMetrics)
    },
  }
}
