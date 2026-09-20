/**
 * overlay-window glue tests (vi.mock('electron') pattern, see
 * pointer-through-glue.test.ts): window posture (transparent frameless
 * screen-saver-level fullscreen) and the occlusion-freeze fix pin — one
 * setOpacity(254/255) call that keeps Electron's internal layered_ flag set
 * so the interactive state never strips WS_EX_LAYERED (a fullscreen un-
 * layered topmost window makes every Chromium app under it pause rendering).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const created: Array<Record<string, unknown>> = []
  const BrowserWindow = vi.fn(function BrowserWindow(): Record<string, unknown> {
    const win: Record<string, unknown> = {
      setAlwaysOnTop: vi.fn(),
      setBounds: vi.fn(),
      setOpacity: vi.fn(),
      once: vi.fn(),
      webContents: { on: vi.fn(), setWindowOpenHandler: vi.fn() },
    }
    created.push(win)
    return win
  })
  const screen = {
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1600 } }),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
  return { created, BrowserWindow, screen }
})

vi.mock('electron', () => ({ BrowserWindow: electronMocks.BrowserWindow, screen: electronMocks.screen }))

import { createOverlayWindow } from '../../src/main/overlay-window'

beforeEach(() => {
  electronMocks.created.length = 0
  electronMocks.BrowserWindow.mockClear()
})

describe('createOverlayWindow', () => {
  it('creates a transparent frameless non-focusable window over the primary display', () => {
    createOverlayWindow()
    expect(electronMocks.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        transparent: true,
        frame: false,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
      }),
    )
    const win = electronMocks.created[0] as { setAlwaysOnTop: ReturnType<typeof vi.fn>; setBounds: ReturnType<typeof vi.fn> }
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver')
    expect(win.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 2560, height: 1600 })
  })

  it('pins layered_ via one setOpacity(254/255) — the occlusion-freeze fix', () => {
    createOverlayWindow()
    const win = electronMocks.created[0] as { setOpacity: ReturnType<typeof vi.fn> }
    expect(win.setOpacity).toHaveBeenCalledTimes(1)
    const alpha = win.setOpacity.mock.calls[0][0] as number
    // Any value strictly between 0.99 and 1 keeps the window layered with
    // alpha < 255 (never an occluder) while staying visually imperceptible.
    expect(alpha).toBeGreaterThan(0.99)
    expect(alpha).toBeLessThan(1)
    expect(alpha).toBeCloseTo(254 / 255, 10)
  })

  it('locks navigation to loopback and denies window.open (v0.4.0 security review)', () => {
    createOverlayWindow()
    const win = electronMocks.created[0] as {
      webContents: {
        on: ReturnType<typeof vi.fn>
        setWindowOpenHandler: ReturnType<typeof vi.fn>
      }
    }
    expect(win.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1)
    const registered = win.webContents.on.mock.calls.find(([name]) => name === 'will-navigate')
    expect(registered).toBeDefined()
    const guard = registered![1] as (event: { preventDefault(): void }, url: string) => void
    const blocked = { preventDefault: vi.fn() }
    guard(blocked, 'https://attacker.example/payload') // remote — denied
    guard(blocked, 'file:///C:/Windows/win.ini') // file:// — denied
    expect(blocked.preventDefault).toHaveBeenCalledTimes(2)
    guard(blocked, 'http://127.0.0.1:5173/overlay/index.html') // dev server — allowed
    guard(blocked, 'http://localhost:51731/settings.html') // prod same-origin — allowed
    expect(blocked.preventDefault).toHaveBeenCalledTimes(2)
  })
})
