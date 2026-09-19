/**
 * animator-window glue tests (vi.mock('electron') pattern, see
 * pointer-through-glue.test.ts): singleton reuse, the local-server URL
 * (dev and prod alike — the page is never served by vite), close→hide while
 * the predicate allows, quit-path close running through, and the sandbox
 * posture (no preload, no node in the page).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeWindow {
  listeners: Map<string, (event: unknown) => void>
  onceHandlers: Map<string, () => void>
  on(name: string, listener: (event: unknown) => void): void
  once(name: string, handler: () => void): void
  loadURL: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
}

const electronMocks = vi.hoisted(() => {
  const created: FakeWindow[] = []
  // A REGULAR function (not an arrow): the module under test invokes it with
  // `new`, and returning an object from a constructor replaces `this`.
  const BrowserWindow = vi.fn(function BrowserWindow(): FakeWindow {
    const listeners = new Map<string, (event: unknown) => void>()
    const onceHandlers = new Map<string, () => void>()
    const win: FakeWindow = {
      listeners,
      onceHandlers,
      on: (name, listener) => {
        listeners.set(name, listener)
      },
      once: (name, handler) => {
        onceHandlers.set(name, handler)
      },
      loadURL: vi.fn(() => Promise.resolve()),
      show: vi.fn(),
      focus: vi.fn(),
      hide: vi.fn(),
      isDestroyed: () => false,
    }
    created.push(win)
    return win
  })
  return { created, BrowserWindow }
})

vi.mock('electron', () => ({ BrowserWindow: electronMocks.BrowserWindow }))

import { animatorWindowOrNull, openAnimatorWindow } from '../../src/main/animator-window'

const LOAD = { serverPort: 18123 }
const hiding = { shouldHideOnClose: () => true }
const quitting = { shouldHideOnClose: () => false }

beforeEach(() => {
  electronMocks.created.length = 0
  electronMocks.BrowserWindow.mockClear()
})

afterEach(() => {
  // Fire the module's own 'closed' handlers: the singleton drops its
  // reference the same way a real quit-time destroy would.
  for (const win of electronMocks.created) {
    win.listeners.get('closed')?.(undefined)
  }
})

describe('openAnimatorWindow', () => {
  it('creates one window loading the local-server page (dev and prod alike)', () => {
    const win = openAnimatorWindow(LOAD, hiding)
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(1)
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    expect(win.loadURL).toHaveBeenCalledWith('http://127.0.0.1:18123/petween-animator/')
    expect(win.onceHandlers.has('ready-to-show')).toBe(true) // shown without a white flash
  })

  it('reuses the live singleton instead of stacking windows', () => {
    const first = openAnimatorWindow(LOAD, hiding)
    const second = openAnimatorWindow(LOAD, hiding)
    expect(second).toBe(first)
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(1)
    expect(first.show).toHaveBeenCalledTimes(1)
    expect(first.focus).toHaveBeenCalledTimes(1)
    expect(animatorWindowOrNull()).toBe(first)
  })

  it('close→hide keeps the draft alive while the predicate allows', () => {
    const win = openAnimatorWindow(LOAD, hiding)
    const close = win.listeners.get('close')
    expect(close).toBeDefined()
    const event = { preventDefault: vi.fn() }
    close?.(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(win.hide).toHaveBeenCalledTimes(1)
  })

  it('a quit-time close runs through (no preventDefault, no hide)', () => {
    const win = openAnimatorWindow(LOAD, quitting)
    const close = win.listeners.get('close')
    const event = { preventDefault: vi.fn() }
    close?.(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(win.hide).not.toHaveBeenCalled()
  })

  it('a destroyed window is forgotten; the next open creates a fresh one', () => {
    const first = openAnimatorWindow(LOAD, hiding)
    first.isDestroyed = () => true
    expect(animatorWindowOrNull()).toBeNull()
    const second = openAnimatorWindow(LOAD, hiding)
    expect(second).not.toBe(first)
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(2)
  })

  it('sandbox + contextIsolation stay on (no preload, no node in the page)', () => {
    openAnimatorWindow(LOAD, hiding)
    const options = electronMocks.BrowserWindow.mock.calls[0]?.[0] as {
      webPreferences?: Record<string, unknown>
    }
    expect(options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true })
    expect(options.webPreferences?.preload).toBeUndefined()
  })
})
