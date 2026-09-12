/**
 * Phase 0 entry — a plain hello window proving the electron-vite three-part
 * scaffold runs. The overlay window (transparent, always-on-top, click-through)
 * replaces this in Phase 2; the local-server and DSH bridge land in Phases 1/4.
 */
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

function createHelloWindow(): void {
  const win = new BrowserWindow({
    width: 480,
    height: 360,
    title: 'Petween Desktop',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[petween-desktop] preload failed to load (${preloadPath}):`, error)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay/index.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/overlay/index.html'))
  }
}

app.whenReady().then(() => {
  createHelloWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createHelloWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
