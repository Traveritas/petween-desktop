/**
 * settings-window.ts — the normal window carrying the host-served settings
 * editor. Loaded straight from the local-server in BOTH modes (it is not a
 * vite page), so dev and prod behave identically. close→hide is attached
 * here, gated by the injected predicate, so repeated open() calls never
 * stack duplicate close handlers.
 */
import { BrowserWindow } from 'electron'

export interface SettingsWindowOptions {
  /** close→hide while true; the tray quit path flips this to false. */
  shouldHideOnClose(): boolean
}

let settingsWindow: BrowserWindow | null = null

export function openSettingsWindow(serverPort: number, options: SettingsWindowOptions): BrowserWindow {
  if (settingsWindow !== null && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Petween 设置',
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
    },
  })
  settingsWindow = win
  win.once('ready-to-show', () => win.show())
  void win.loadURL(`http://127.0.0.1:${serverPort}/petween-editor/`)
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
