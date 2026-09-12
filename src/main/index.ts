/**
 * Electron entry. The shell stays thin (docs/04 §7): app lifecycle, path and
 * port orchestration, window creation. All business logic lives in
 * Electron-free modules (local-server, routes-host, state-relay, ...).
 *
 * Phase 1: boots the petween local-server (host assembly + editor page +
 * state channel) alongside the Phase 0 hello window. The overlay window
 * replaces the hello window in Phase 2.
 */
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { DEV_LOCAL_PORT } from './dev-port'
import { startPetweenLocalServer } from './local-server'

async function bootstrap(): Promise<void> {
  const isDev = !app.isPackaged
  const dataRoot = join(app.getPath('userData'), 'petween-home')
  const editorBundlePath =
    process.env.PETWEEN_EDITOR_BUNDLE ?? join(app.getAppPath(), 'vendor', 'petween', 'lib', 'editor.js')
  const port = process.env.PETWEEN_LOCAL_PORT
    ? Number.parseInt(process.env.PETWEEN_LOCAL_PORT, 10)
    : isDev
      ? DEV_LOCAL_PORT
      : 0

  const server = await startPetweenLocalServer({ dataRoot, editorBundlePath, port })
  console.log(`[petween-desktop] local-server on http://127.0.0.1:${server.port} (data: ${dataRoot})`)

  app.on('quit', () => {
    void server.close()
  })

  createHelloWindow()
}

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
  void bootstrap()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
