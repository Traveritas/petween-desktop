/**
 * settings-window.ts — the combined desktop settings window (连接 / 宠物 /
 * 交互 / 通用). Dev loads the vite page; prod loads the local-server-served
 * build. The petween editor lives INSIDE this window as a same-origin iframe
 * (docs: editor-embeddability research) — no separate editor window.
 * close→hide is attached here, gated by the injected predicate, so repeated
 * open() calls never stack duplicate close handlers.
 */
import { BrowserWindow } from 'electron'
import { lockNavigationToLoopback } from './window-nav'

export interface SettingsWindowLoad {
  serverPort: number
  devUrl?: string
}

export interface SettingsWindowOptions {
  /** close→hide while true; the tray quit path flips this to false. */
  shouldHideOnClose(): boolean
}

let settingsWindow: BrowserWindow | null = null

export function openSettingsWindow(load: SettingsWindowLoad, options: SettingsWindowOptions): BrowserWindow {
  if (settingsWindow !== null && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    // 1001px (editor three-column) + 191px nav + ~16px window frame:
    // at 1120 the pane only got ~913px and the layout silently degraded.
    minWidth: 1210,
    minHeight: 700,
    title: 'Petween 设置',
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
    },
  })
  settingsWindow = win
  lockNavigationToLoopback(win)
  win.once('ready-to-show', () => win.show())
  if (load.devUrl !== undefined) {
    void win.loadURL(`${load.devUrl}/settings/index.html`).catch((error: unknown) => {
      console.error('[petween-desktop] settings page failed to load', error)
    })
  } else {
    void win.loadURL(`http://127.0.0.1:${load.serverPort}/settings.html`).catch((error: unknown) => {
      console.error('[petween-desktop] settings page failed to load', error)
    })
  }
  win.on('close', (event) => {
    if (options.shouldHideOnClose()) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null
  })
  return win
}

export function settingsWindowOrNull(): BrowserWindow | null {
  return settingsWindow !== null && !settingsWindow.isDestroyed() ? settingsWindow : null
}
