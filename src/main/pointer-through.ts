/**
 * pointer-through.ts — the Electron glue around the pure decision logic
 * (docs/04 §2). Owns the IPC channel, the 250ms cursor poll, applying
 * setIgnoreMouseEvents on state change, and the known-pitfall re-applies:
 * forward:true dies after a page reload (#15376) and DevTools breaks
 * transparency entirely (warn, never silently mis-test).
 */
import { ipcMain, screen, type BrowserWindow, type IpcMainEvent } from 'electron'
import {
  decideInteractive,
  type PointerThroughState,
  type Rect,
  type RendererSignal,
} from './pointer-through-logic'

export const POINTER_SIGNAL_CHANNEL = 'petween:pointer-signal'

const POLL_MS = 250

interface WireSignal {
  bodyRect: Rect | null
  dragging: boolean
  hoverHit: boolean
  cursorClient: { x: number; y: number } | null
}

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

export function attachPointerThrough(win: BrowserWindow): { dispose(): void } {
  let state: PointerThroughState = { interactive: false, bodyRect: null }
  let applied: boolean | null = null
  let signal: RendererSignal | null = null
  let signalAt: number | null = null

  const apply = (): void => {
    if (applied === state.interactive) return
    applied = state.interactive
    console.log(`[petween-desktop] pointer-through: ${state.interactive ? 'interactive' : 'click-through'}`)
    if (state.interactive) win.setIgnoreMouseEvents(false)
    else win.setIgnoreMouseEvents(true, { forward: true })
  }

  const evaluate = (): void => {
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
    )
    apply()
  }

  const onSignal = (event: IpcMainEvent, payload: unknown): void => {
    if (event.sender !== win.webContents) return
    const sanitized = sanitizeSignal(payload)
    if (sanitized === null) return
    signal = sanitized
    signalAt = Date.now()
    evaluate()
  }
  ipcMain.on(POINTER_SIGNAL_CHANNEL, onSignal)

  const onFinishedLoad = (): void => {
    // Forwarding silently dies across reloads (#15376): force the next apply.
    applied = null
    evaluate()
  }
  win.webContents.on('did-finish-load', onFinishedLoad)

  const onDevToolsOpened = (): void => {
    console.warn(
      '[petween-desktop] DevTools is open — the transparent overlay stops being transparent and click-through cannot be tested. Detach/close DevTools before verifying.',
    )
  }
  win.webContents.on('devtools-opened', onDevToolsOpened)

  const timer = setInterval(evaluate, POLL_MS)
  evaluate() // start click-through with forwarding immediately

  return {
    dispose(): void {
      clearInterval(timer)
      ipcMain.removeListener(POINTER_SIGNAL_CHANNEL, onSignal)
      win.webContents.removeListener('did-finish-load', onFinishedLoad)
      win.webContents.removeListener('devtools-opened', onDevToolsOpened)
    },
  }
}

export type { WireSignal }
