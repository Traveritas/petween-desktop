/**
 * overlay-window.ts — the transparent always-on-top overlay window (docs/04
 * §1). All Electron window API calls for the overlay live here; bounds math
 * is trivial (setBounds with display.bounds, never fullscreen/maximize).
 *
 * MVP: one window on the primary display; re-fits on display-metrics-changed.
 * The window is NOT focusable and does not take part in alt-tab/taskbar.
 */
import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'

export function createOverlayWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay()
  const win = new BrowserWindow({
    transparent: true,
    frame: false,
    resizable: false, // transparent windows must not maximize/fullscreen
    show: false,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false, // pet animations must not pause when unfocused
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setBounds(primary.bounds)
  // showInactive: focusable:false windows could still steal focus via
  // show() on Windows (electron#11049).

  const refit = (display: Electron.Display): void => {
    if (display.id === primary.id) win.setBounds(display.bounds)
  }
  const onMetricsChanged = (_event: Electron.Event, display: Electron.Display): void => refit(display)
  screen.on('display-metrics-changed', onMetricsChanged)
  win.once('closed', () => {
    screen.removeListener('display-metrics-changed', onMetricsChanged)
  })

  return win
}

/** Loads the overlay page: dev = vite dev server (proxied API), prod = local-server (same origin). */
export function loadOverlayPage(win: BrowserWindow, options: { devUrl?: string; serverPort?: number }): void {
  if (options.devUrl !== undefined) {
    void win.loadURL(`${options.devUrl}/overlay/index.html`)
  } else if (options.serverPort !== undefined) {
    void win.loadURL(`http://127.0.0.1:${options.serverPort}/overlay.html`)
  } else {
    throw new Error('overlay window needs either a dev URL or the local-server port')
  }
  win.once('ready-to-show', () => win.showInactive())
}
