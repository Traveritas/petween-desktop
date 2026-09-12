/**
 * Electron entry. The shell stays thin (docs/04 §7): app lifecycle, path and
 * port orchestration, window creation. All business logic lives in
 * Electron-free modules (local-server, dsh-bridge, pointer-through, ...).
 *
 * Phase 5: single-instance lock (second launch re-opens settings), tray
 * (status / settings / auto-launch / import / quit), settings window with
 * close→hide, and a tray-owned quit — window-all-closed never quits.
 */
import { app, dialog } from 'electron'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { DEV_LOCAL_PORT } from './dev-port'
import { createDshBridge } from './dsh-bridge/bridge'
import { describeDsh } from './dsh-bridge/dsh-client'
import { connectDshSocket } from './dsh-bridge/ws-socket'
import { getAutoLaunch, setAutoLaunch } from './login-item'
import { importLegacyData, legacyHomeHasData, targetHomeCanImport } from './legacy-import'
import { startPetweenLocalServer, type PetweenLocalServer } from './local-server'
import { attachPointerThrough } from './pointer-through'
import { createOverlayWindow, loadOverlayPage } from './overlay-window'
import { openSettingsWindow } from './settings-window'
import { createPetweenTray } from './tray'
import type { TrayMenuState } from './tray-menu'

let isQuitting = false
let server: PetweenLocalServer | null = null
let openSettings: (() => void) | null = null

app.on('before-quit', () => {
  isQuitting = true
})

const singleLock = app.requestSingleInstanceLock()
if (!singleLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    openSettings?.()
  })

  app.whenReady().then(() => {
    void bootstrap()
  })

  // The pet overlay + tray own the lifetime; an accidental window-all-closed
  // (e.g. the settings window) must not quit the app.
  app.on('window-all-closed', () => {})
}

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

  server = await startPetweenLocalServer({
    dataRoot,
    editorBundlePath,
    // Prod serves the built overlay page from the local-server (same origin).
    rendererDistDir: isDev ? undefined : join(__dirname, '../renderer'),
    port,
  })
  console.log(`[petween-desktop] local-server on http://127.0.0.1:${server.port} (data: ${dataRoot})`)

  const legacyRoot = dshHomePath('petween')
  let dshConnected = false

  const openSettingsWindowNow = (): void => {
    if (server !== null) {
      openSettingsWindow(server.port, { shouldHideOnClose: () => !isQuitting })
    }
  }
  openSettings = openSettingsWindowNow

  const trayState = (): TrayMenuState => ({
    dshConnected,
    autoLaunchEnabled: getAutoLaunch(),
    canToggleAutoLaunch: app.isPackaged,
    canImportFromDsh: legacyHomeHasData(legacyRoot) && targetHomeCanImport(dataRoot),
  })
  const tray = createPetweenTray({
    onAction(action) {
      switch (action) {
        case 'open-settings':
          openSettingsWindowNow()
          break
        case 'toggle-auto-launch':
          setAutoLaunch(!getAutoLaunch())
          tray.update(trayState())
          break
        case 'import-from-dsh':
          void runLegacyImport(legacyRoot, dataRoot, () => tray.update(trayState()))
          break
        case 'quit':
          app.quit()
          break
      }
    },
  })

  // DSH state bridge (docs/05 Phase 4): aggregate mode — no CurrentSessionSource,
  // petween's §14.5 fallback subscribes the overlay to every session's stream.
  const bridge = createDshBridge({
    relay: server.relay,
    getPort: () =>
      process.env.PETWEEN_DSH_PORT ? Number.parseInt(process.env.PETWEEN_DSH_PORT, 10) : 3080,
    connect: connectDshSocket,
    describe: describeDsh,
    log: (message) => console.log(message),
    onStatus: (status, detail) => {
      console.log(`[petween-dsh] ${status}${detail === undefined ? '' : ` (${detail})`}`)
      dshConnected = status === 'connected'
      tray.update(trayState())
    },
  })
  bridge.start()
  tray.update(trayState())

  app.on('quit', () => {
    bridge.close()
    tray.destroy()
    void server?.close()
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

async function runLegacyImport(
  legacyRoot: string,
  dataRoot: string,
  refresh: () => void,
): Promise<void> {
  const confirmed = await dialog.showMessageBox({
    type: 'question',
    title: '从 DSH 导入数据',
    message: `把 DSH 插件版的数据（图片 / 动画 / 宠物预设）复制到桌面版吗？\n\n来源：${legacyRoot}\n已有同名内容不会被覆盖。`,
    buttons: ['导入', '取消'],
    defaultId: 0,
    cancelId: 1,
  })
  if (confirmed.response !== 0) return
  const report = importLegacyData(legacyRoot, dataRoot)
  refresh()
  await dialog.showMessageBox({
    type: 'info',
    title: '从 DSH 导入数据',
    message:
      report.copied.length > 0
        ? `已导入：${report.copied.join('、')}。\n在设置里选择导入的宠物预设即可。`
        : '没有可导入的内容（目标已存在或来源为空）。',
  })
}
