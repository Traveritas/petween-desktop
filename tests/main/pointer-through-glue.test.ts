/**
 * pointer-through glue tests (2026-09-16 milestone review gap #1) — the
 * first test to use the project's stated vi.mock('electron') pattern.
 * Covers: IPC sanitization, sender guard, state application via
 * setIgnoreMouseEvents calls, drag-end reissue, interactive lock, forward
 * flag plumbing, dispose inertness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (event: unknown, payload: unknown) => void>()
  const windowListeners = new Map<string, Array<() => void>>()
  const screenListeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const powerListeners = new Map<string, Array<() => void>>()
  return {
    ipcHandlers,
    windowListeners,
    screenListeners,
    powerListeners,
    setIgnoreMouseEvents: vi.fn(),
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: (event: unknown, payload: unknown) => void) => {
      electronMocks.ipcHandlers.set(channel, handler)
    },
    removeListener: (channel: string) => {
      electronMocks.ipcHandlers.delete(channel)
    },
  },
  screen: {
    getCursorScreenPoint: electronMocks.getCursorScreenPoint,
    on: (name: string, listener: (...args: unknown[]) => void) => {
      const list = electronMocks.screenListeners.get(name) ?? []
      list.push(listener)
      electronMocks.screenListeners.set(name, list)
    },
    removeListener: (name: string) => {
      electronMocks.screenListeners.delete(name)
    },
  },
  powerMonitor: {
    on: (name: string, listener: () => void) => {
      const list = electronMocks.powerListeners.get(name) ?? []
      list.push(listener)
      electronMocks.powerListeners.set(name, list)
    },
    removeListener: (name: string) => {
      electronMocks.powerListeners.delete(name)
    },
  },
}))

import { attachPointerThrough, POINTER_SIGNAL_CHANNEL, type PointerThroughHandle } from '../../src/main/pointer-through'
import type { BrowserWindow, IpcMainEvent } from 'electron'

function fakeWindow(): BrowserWindow {
  const webContents = {
    on: (name: string, listener: () => void) => {
      const list = electronMocks.windowListeners.get(name) ?? []
      list.push(listener)
      electronMocks.windowListeners.set(name, list)
    },
    removeListener: (name: string) => {
      electronMocks.windowListeners.delete(name)
    },
  }
  return {
    webContents,
    setIgnoreMouseEvents: electronMocks.setIgnoreMouseEvents,
    getContentBounds: () => ({ x: 0, y: 0, width: 2560, height: 1600 }),
    // The quit-time guards ask before touching the window.
    isDestroyed: () => false,
  } as unknown as BrowserWindow
}

const SIGNAL = POINTER_SIGNAL_CHANNEL

function emit(win: BrowserWindow, payload: unknown): void {
  const handler = electronMocks.ipcHandlers.get(SIGNAL)
  if (handler === undefined) throw new Error('no signal handler registered')
  handler({ sender: win.webContents } as unknown as IpcMainEvent, payload)
}

function calls(): Array<[boolean, { forward?: boolean } | undefined]> {
  return electronMocks.setIgnoreMouseEvents.mock.calls as Array<[boolean, { forward?: boolean } | undefined]>
}

/** First argument of the most recent setIgnoreMouseEvents call. */
function lastIgnore(): boolean {
  return calls().at(-1)![0]!
}

let handle: PointerThroughHandle | null = null

beforeEach(() => {
  electronMocks.setIgnoreMouseEvents.mockClear()
  electronMocks.getCursorScreenPoint.mockClear()
  electronMocks.getCursorScreenPoint.mockReturnValue({ x: 0, y: 0 })
})
afterEach(() => {
  handle?.dispose()
  handle = null
  electronMocks.ipcHandlers.clear()
  electronMocks.windowListeners.clear()
})

describe('pointer-through glue', () => {
  it('applies PLAIN click-through at attach (no forwarding hook far from the pet)', () => {
    const win = fakeWindow()
    handle = attachPointerThrough(win, { mode: 'auto', hitPaddingPx: 6, forwardMouseMoves: true, selfHealing: false })
    // no bodyRect + cursor far → the near band never opens: no hook.
    expect(calls().at(-1)![0]).toBe(true)
    expect(calls().at(-1)![1]).toBeUndefined()
  })

  it('a bodyRect near the cursor opens the forward band (hook installs)', () => {
    const win = fakeWindow()
    handle = attachPointerThrough(win, { mode: 'auto', hitPaddingPx: 6, forwardMouseMoves: true, selfHealing: false })
    electronMocks.setIgnoreMouseEvents.mockClear()
    // cursor (0,0) via mock; a rect around it makes the poll near.
    emit(win, { hoverHit: false, dragging: false, bodyRect: { x: 20, y: 20, width: 100, height: 100 } })
    expect(calls().at(-1)).toEqual([true, { forward: true }])
  })

  it('malformed signals and foreign senders change nothing', () => {
    const win = fakeWindow()
    handle = attachPointerThrough(win, { mode: 'auto', hitPaddingPx: 6, forwardMouseMoves: true, selfHealing: false })
    electronMocks.setIgnoreMouseEvents.mockClear()
    emit(win, { dragging: false }) // missing hoverHit → dropped
    emit(win, null)
    emit(win, 'garbage')
    const foreign = fakeWindow()
    const handler = electronMocks.ipcHandlers.get(SIGNAL)!
    handler({ sender: foreign.webContents } as unknown as IpcMainEvent, { hoverHit: true, dragging: false })
    expect(calls()).toHaveLength(0)
  })

  it('a fresh hover signal flips the window interactive', () => {
    const win = fakeWindow()
    handle = attachPointerThrough(win, { mode: 'auto', hitPaddingPx: 6, forwardMouseMoves: true, selfHealing: false })
    electronMocks.setIgnoreMouseEvents.mockClear()
    emit(win, { hoverHit: true, dragging: false, bodyRect: null })
    expect(lastIgnore()).toBe(false)
    expect(calls().at(-1)).toHaveLength(1) // no options on the interactive call
  })

  it('a drag ending re-issues the native state and falls back to click-through (#41501 re-anchor)', () => {
    const win = fakeWindow()
    handle = attachPointerThrough(win, { mode: 'auto', hitPaddingPx: 6, forwardMouseMoves: true, selfHealing: false })
    emit(win, { hoverHit: false, dragging: true, bodyRect: null })
    expect(lastIgnore()).toBe(false) // dragging holds interactive
    electronMocks.setIgnoreMouseEvents.mockClear()
    emit(win, { hoverHit: false, dragging: false, bodyRect: null })
    // the re-anchor forces a redundant native call even though state changed
    expect(calls().length).toBeGreaterThanOrEqual(1)
    expect(lastIgnore()).toBe(true) // gesture over → back to click-through
    expect(calls().at(-1)![1]).toBeUndefined() // far from the pet: plain, no hook
  })

  it('the interactive lock overrides always-through', () => {
    const win = fakeWindow()
    handle = attachPointerThrough(win, { mode: 'always-through', hitPaddingPx: 6, forwardMouseMoves: true, selfHealing: false })
    expect(calls().at(-1)![0]).toBe(true)
    expect(calls().at(-1)![1]).toBeUndefined() // always-through: never a hook
    handle.setInteractiveLock(true)
    expect(lastIgnore()).toBe(false)
    handle.toggleInteractiveLock()
    expect(calls().at(-1)![0]).toBe(true)
    expect(calls().at(-1)![1]).toBeUndefined()
  })

  it('updateOptions turns forwarding off inside the band (plain everywhere)', () => {
    const win = fakeWindow()
    handle = attachPointerThrough(win, { mode: 'auto', hitPaddingPx: 6, forwardMouseMoves: true, selfHealing: false })
    emit(win, { hoverHit: false, dragging: false, bodyRect: { x: 20, y: 20, width: 100, height: 100 } })
    expect(calls().at(-1)).toEqual([true, { forward: true }]) // in-band: hook on
    handle.updateOptions({ mode: 'auto', hitPaddingPx: 6, forwardMouseMoves: false, selfHealing: false })
    expect(calls().at(-1)![0]).toBe(true)
    expect(calls().at(-1)![1]).toBeUndefined() // setting off: hook never installs
  })

  it('self-healing re-asserts periodically', () => {
    vi.useFakeTimers()
    try {
      const win = fakeWindow()
      handle = attachPointerThrough(win, { mode: 'auto', hitPaddingPx: 6, forwardMouseMoves: true, selfHealing: true })
      electronMocks.setIgnoreMouseEvents.mockClear()
      vi.advanceTimersByTime(5_100)
      expect(calls().length).toBeGreaterThanOrEqual(1) // periodic re-issue
    } finally {
      vi.useRealTimers()
    }
  })

  it('after dispose, the IPC channel is unregistered and no calls happen', () => {
    const win = fakeWindow()
    handle = attachPointerThrough(win, { mode: 'auto', hitPaddingPx: 6, forwardMouseMoves: true, selfHealing: false })
    handle.dispose()
    handle = null
    electronMocks.setIgnoreMouseEvents.mockClear()
    expect(electronMocks.ipcHandlers.has(SIGNAL)).toBe(false)
    expect(calls()).toHaveLength(0)
  })
})
