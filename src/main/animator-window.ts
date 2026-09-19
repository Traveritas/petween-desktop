/**
 * animator-window.ts — the standalone animation workbench window
 * (/petween-animator/, docs/05 Phase 11). On-demand like the settings
 * window: created at the first open (tray menu / settings 宠物 pane button),
 * close→hide keeps the unsaved timeline draft alive, destroyed only at quit.
 *
 * The page is served by the local-server in dev AND prod (self-contained
 * petween IIFE bundle, same delivery as the editor iframe) — no vite entry,
 * no preload; the page talks to /api/petween/* directly.
 */
import { BrowserWindow } from 'electron'

export interface AnimatorWindowLoad {
  serverPort: number
}

export interface AnimatorWindowOptions {
  /** close→hide while true; the quit path flips this to false. */
  shouldHideOnClose(): boolean
}

let animatorWindow: BrowserWindow | null = null

export function openAnimatorWindow(load: AnimatorWindowLoad, options: AnimatorWindowOptions): BrowserWindow {
  if (animatorWindow !== null && !animatorWindow.isDestroyed()) {
    animatorWindow.show()
    animatorWindow.focus()
    return animatorWindow
  }
  const win = new BrowserWindow({
    width: 1500,
    height: 960,
    // Workbench grid: 300px library column + timeline. Below ~1100 CSS px
    // the page stacks its top row (see animator.module.css); the timeline
    // stays usable.
    minWidth: 980,
    minHeight: 640,
    title: 'Petween 动画编辑器',
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
    },
  })
  animatorWindow = win
  win.once('ready-to-show', () => win.show())
  void win.loadURL(`http://127.0.0.1:${load.serverPort}/petween-animator/`).catch((error: unknown) => {
    console.error('[petween-desktop] animator page failed to load', error)
  })
  win.on('close', (event) => {
    if (options.shouldHideOnClose()) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    if (animatorWindow === win) animatorWindow = null
  })
  return win
}

export function animatorWindowOrNull(): BrowserWindow | null {
  return animatorWindow !== null && !animatorWindow.isDestroyed() ? animatorWindow : null
}
