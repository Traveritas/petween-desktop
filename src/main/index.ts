/**
 * Electron entry. The shell stays thin (docs/04 §7): app lifecycle, path and
 * port orchestration, window creation. All business logic lives in
 * Electron-free modules (local-server, routes-host, state-relay, ...).
 *
 * Phase 2: boots the petween local-server and the transparent always-on-top
 * overlay window (dev: vite dev server + API proxy; prod: same-origin
 * local-server for both the page and the API).
 */
import { app } from 'electron'
import { join } from 'node:path'
import { DEV_LOCAL_PORT } from './dev-port'
import { startPetweenLocalServer } from './local-server'
import { attachPointerThrough } from './pointer-through'
import { createOverlayWindow, loadOverlayPage } from './overlay-window'

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

  const server = await startPetweenLocalServer({
    dataRoot,
    editorBundlePath,
    // Prod serves the built overlay page from the local-server (same origin).
    rendererDistDir: isDev ? undefined : join(__dirname, '../renderer'),
    port,
  })
  console.log(`[petween-desktop] local-server on http://127.0.0.1:${server.port} (data: ${dataRoot})`)

  app.on('quit', () => {
    void server.close()
  })

  const overlay = createOverlayWindow()
  // Click-through from the very first frame (docs/05 Phase 3).
  const pointerThrough = attachPointerThrough(overlay)
  overlay.once('closed', () => pointerThrough.dispose())
  loadOverlayPage(overlay, {
    devUrl: process.env.ELECTRON_RENDERER_URL,
    serverPort: server.port,
  })
}

app.whenReady().then(() => {
  void bootstrap()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
