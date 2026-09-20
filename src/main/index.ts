/**
 * Electron entry. The shell stays thin (docs/04 §7): app lifecycle, path and
 * port orchestration, window creation. All business logic lives in
 * Electron-free modules (local-server, dsh-bridge, pointer-through, ...).
 *
 * Phase 5+: single-instance lock, tray, close→hide, tray-owned quit.
 * Settings phase (2026-09-14): the desktop settings store drives the DSH
 * bridge and the click-through engine live; the settings window is the
 * shell-owned page (连接 / 宠物[iframe] / 交互 / 通用).
 */
import { app, dialog, globalShortcut } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { openAnimatorWindow } from './animator-window'
import { DEV_LOCAL_PORT } from './dev-port'
import { createZcodeConnector } from './connectors/zcode-connector'
import { createCcConnector } from './connectors/cc-connector'
import {
  installCcHooks,
  uninstallCcHooks,
  writeCcHookConfigs,
  ccHooksInstalled,
  type CcHooksPaths,
} from './connectors/cc-hooks'
import { registerCcConnectorRoutes } from './connectors/cc-routes'
import { createStatsLedger } from './connectors/stats-ledger'
import { registerStatsRoutes } from './connectors/stats-routes'
import { createDialogueSource } from './connectors/dialogue-source'
import { createCcDialogueSource } from './connectors/cc-dialogue-source'
import { registerDialogueRoutes } from './connectors/dialogue-routes'
import {
  installZcodeHooks,
  uninstallZcodeHooks,
  writeZcodeHookConfigs,
  zcodeHooksInstalled,
  type ZcodeHooksPaths,
} from './connectors/zcode-hooks'
import { registerZcodeConnectorRoutes } from './connectors/zcode-routes'
import { registerDesktopRoutes, type DesktopStatus } from './desktop-routes'
import {
  createDesktopSettingsStore,
  type DesktopSettings,
  type DesktopSettingsStore,
} from './desktop-settings'
import { createDshBridge } from './dsh-bridge/bridge'
import { describeDsh } from './dsh-bridge/dsh-client'
import { connectDshSocket } from './dsh-bridge/ws-socket'
import { getAutoLaunch, setAutoLaunch } from './login-item'
import { importLegacyData, legacyHomeHasData, targetHomeCanImport } from './legacy-import'
import { startPetweenLocalServer, type PetweenLocalServer } from './local-server'
import { assemblePhysics } from './physics-assembly'
import { attachPointerThrough, type PointerThroughHandle, type PointerThroughRuntimeOptions } from './pointer-through'
import { createOverlayWindow, loadOverlayPage } from './overlay-window'
import { openSettingsWindow } from './settings-window'
import { createPetweenTray } from './tray'
import type { TrayMenuState } from './tray-menu'
import { installStdoutEpipeGuard } from './stdout-epipe-guard'

// Before any logging: a dead inherited console pipe must not turn console.log
// into a dialog-spamming uncaught exception (see stdout-epipe-guard.ts).
installStdoutEpipeGuard()

const RESCUE_HOTKEY_CANDIDATES = ['Control+Alt+P', 'Control+Alt+I', 'Control+Alt+U']

let isQuitting = false
let server: PetweenLocalServer | null = null
let settingsStore: DesktopSettingsStore | null = null
let pointerThrough: PointerThroughHandle | null = null
let openSettings: (() => void) | null = null
let dshStatus: { connected: boolean; detail?: string } = { connected: false }
let bridgeRestart: ((settings: DesktopSettings) => void) | null = null
let rescueHotkey: string | null = null

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
    // A startup failure must never leave a headless zombie process (no tray,
    // no overlay, window-all-closed already neutered) — surface it and quit.
    bootstrap().catch((error: unknown) => {
      console.error('[petween-desktop] bootstrap failed', error)
      dialog.showErrorBox('Petween 启动失败', String(error))
      app.quit()
    })
  })

  // The pet overlay + tray own the lifetime; an accidental window-all-closed
  // (e.g. the settings window) must not quit the app.
  app.on('window-all-closed', () => {})
}

function pointerOptions(settings: DesktopSettings): PointerThroughRuntimeOptions {
  return {
    mode: settings.clickThrough.mode,
    hitPaddingPx: settings.clickThrough.hitPaddingPx,
    forwardMouseMoves: settings.clickThrough.forwardMouseMoves,
    selfHealing: settings.clickThrough.selfHealing,
  }
}

function dshPortOf(settings: DesktopSettings): number {
  return process.env.PETWEEN_DSH_PORT
    ? Number.parseInt(process.env.PETWEEN_DSH_PORT, 10)
    : settings.dsh.port
}

function syncRescueHotkey(settings: DesktopSettings): void {
  const onRescue = (): void => {
    const locked = pointerThrough?.toggleInteractiveLock()
    console.log(`[petween-desktop] rescue hotkey (${rescueHotkey}): lock ${locked ? 'ON' : 'off'}`)
  }
  if (settings.clickThrough.rescueHotkeyEnabled) {
    if (rescueHotkey !== null) return // already registered
    rescueHotkey = RESCUE_HOTKEY_CANDIDATES.find((accelerator) => globalShortcut.register(accelerator, onRescue)) ?? null
    if (rescueHotkey === null) {
      console.warn(`[petween-desktop] all rescue hotkey candidates occupied: ${RESCUE_HOTKEY_CANDIDATES.join(', ')}`)
    } else if (rescueHotkey !== RESCUE_HOTKEY_CANDIDATES[0]) {
      console.log(`[petween-desktop] rescue hotkey ${RESCUE_HOTKEY_CANDIDATES[0]} occupied — using ${rescueHotkey}`)
    }
  } else {
    if (rescueHotkey !== null) globalShortcut.unregister(rescueHotkey)
    rescueHotkey = null
  }
}

/** The forced-interactive mode was removed 2026-09-16 — nothing to guard. */

async function bootstrap(): Promise<void> {
  const isDev = !app.isPackaged
  const dataRoot = join(app.getPath('userData'), 'petween-home')
  const editorBundlePath =
    process.env.PETWEEN_EDITOR_BUNDLE ?? join(app.getAppPath(), 'vendor', 'petween', 'lib', 'editor.js')
  const animatorBundlePath =
    process.env.PETWEEN_ANIMATOR_BUNDLE ?? join(app.getAppPath(), 'vendor', 'petween', 'lib', 'animator.js')
  const port = process.env.PETWEEN_LOCAL_PORT
    ? Number.parseInt(process.env.PETWEEN_LOCAL_PORT, 10)
    : isDev
      ? DEV_LOCAL_PORT
      : 0

  settingsStore = await createDesktopSettingsStore(join(app.getPath('userData'), 'desktop-settings.json'))
  const settings = settingsStore.get()

  server = await startPetweenLocalServer({
    dataRoot,
    editorBundlePath,
    animatorBundlePath,
    // Prod serves the built overlay/settings pages from the local-server (same origin).
    rendererDistDir: isDev ? undefined : join(__dirname, '../renderer'),
    port,
  })
  console.log(`[petween-desktop] local-server on http://127.0.0.1:${server.port} (data: ${dataRoot})`)

  // petween-physics host half (docs/05 Phase 8C): config route + default
  // bounce animation; data root independent under userData.
  const physics = assemblePhysics({
    host: { webServer: server.webServer },
    petweenHostService: server.petweenHostService,
    configPath: join(app.getPath('userData'), 'petween-physics', 'config.json'),
  })

  const legacyRoot = dshHomePath('petween')

  const openSettingsWindowNow = (): void => {
    if (server !== null) {
      openSettingsWindow(
        { serverPort: server.port, devUrl: process.env.ELECTRON_RENDERER_URL },
        { shouldHideOnClose: () => !isQuitting },
      )
    }
  }
  openSettings = openSettingsWindowNow

  // Phase 11: the standalone animation workbench window (on-demand,
  // close→hide — the timeline draft survives the close).
  const openAnimatorWindowNow = (): void => {
    if (server !== null) {
      openAnimatorWindow({ serverPort: server.port }, { shouldHideOnClose: () => !isQuitting })
    }
  }

  const trayState = (): TrayMenuState => ({
    dshConnected: dshStatus.connected,
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
        case 'open-animator':
          openAnimatorWindowNow()
          break
        case 'toggle-auto-launch':
          setAutoLaunch(!getAutoLaunch())
          tray.update(trayState())
          break
        case 'import-from-dsh':
          // The rejection path is user-facing: a failed copy (disk full,
          // permissions) must tell the user, not die as an unhandled
          // rejection (v0.4.0 review).
          runLegacyImport(legacyRoot, dataRoot, () => tray.update(trayState())).catch((error) => {
            console.error('[petween-desktop] legacy import failed', error)
            void dialog
              .showMessageBox({
                type: 'error',
                title: '从 DSH 导入数据',
                message: '导入失败，数据未改动。',
                detail: String(error instanceof Error ? error.message : error),
              })
              .catch(() => {})
          })
          break
        case 'quit':
          app.quit()
          break
      }
    },
  })

  // Shell settings API (the settings page's only transport).
  registerDesktopRoutes({ webServer: server.webServer }, {
    settings: settingsStore,
    status: (): DesktopStatus => ({
      dsh: { enabled: settingsStore?.get().dsh.enabled ?? true, ...dshStatus },
      appVersion: app.getVersion(),
      dataRoot,
      serverOrigin: `http://127.0.0.1:${server?.port ?? 0}`,
    }),
    fixInteraction: () => pointerThrough?.fixNow(),
    openAnimator: openAnimatorWindowNow,
    getAutoLaunch,
    setAutoLaunch,
    probeDsh: describeDsh,
  })

  // zcode connector (docs/06): hooks POST into this local-server; the curl
  // cfg files carry the current random port so hook registrations stay valid
  // across boots. Disabled in settings = events dropped at the sink.
  // Phase 10: the stats ledger (thinking time + edit line counts) sits behind
  // the connector and serves the HUD companion via /api/petween-desktop/stats.
  const statsLedger = createStatsLedger({ now: () => Date.now() })
  const zcodePaths: ZcodeHooksPaths = {
    cfgDir: join(app.getPath('userData'), 'zcode-hooks'),
    zcodeConfigPath: join(homedir(), '.zcode', 'cli', 'config.json'),
  }
  const zcodeConnector = createZcodeConnector({
    relay: server.relay,
    now: () => Date.now(),
    isFollowEnabled: () => settingsStore?.get().connectors.zcode.followLatestUser ?? false,
    stats: statsLedger,
    log: (message) => console.log(message),
  })
  registerStatsRoutes({ webServer: server.webServer }, { snapshot: (since) => statsLedger.snapshot(since) })
  // Phase 10 second batch: reply-text previews from the zcode rollout files
  // (on-demand read, truncated at the source — the one content-level channel).
  // Phase 15 unbinding: multi-source — CC's transcript registry feeds from
  // hook payloads; the route probes sources in order.
  const dialogueSource = createDialogueSource({ cliDir: () => join(homedir(), '.zcode', 'cli'), now: () => Date.now() })
  const ccDialogueSource = createCcDialogueSource({ claudeDir: () => join(homedir(), '.claude'), now: () => Date.now() })
  registerDialogueRoutes({ webServer: server.webServer }, { sources: [ccDialogueSource, dialogueSource] })
  const zcodeEnabled = (): boolean => settingsStore?.get().connectors.zcode.enabled ?? true
  const syncZcodeCfgFiles = (): Promise<void> => {
    if (!zcodeEnabled() || server === null) return Promise.resolve()
    return writeZcodeHookConfigs(zcodePaths.cfgDir, server.port).catch((error: unknown) => {
      console.error('[petween-zcode] cfg sync failed', error)
    })
  }
  void syncZcodeCfgFiles()
  registerZcodeConnectorRoutes({ webServer: server.webServer }, {
    isEnabled: zcodeEnabled,
    onHookEvent: (input) => zcodeConnector.handle(input),
    connectorStatus: async () => ({
      ...zcodeConnector.status(),
      enabled: zcodeEnabled(),
      hooksInstalled: await zcodeHooksInstalled(zcodePaths),
    }),
    installHooks: async () => {
      await syncZcodeCfgFiles()
      await installZcodeHooks(zcodePaths)
    },
    uninstallHooks: async () => {
      await uninstallZcodeHooks(zcodePaths)
    },
  })

  // Claude Code connector (Phase 15, docs/07): same architecture on the
  // shared hook-connector engine. CC hot-reloads settings.json, so installs
  // go live without a client restart (unlike zcode).
  const ccPaths: CcHooksPaths = {
    cfgDir: join(app.getPath('userData'), 'cc-hooks'),
    settingsPath: join(homedir(), '.claude', 'settings.json'),
  }
  const ccConnector = createCcConnector({
    relay: server.relay,
    now: () => Date.now(),
    isFollowEnabled: () => settingsStore?.get().connectors.cc.followLatestUser ?? false,
    stats: statsLedger,
    log: (message) => console.log(message),
  })
  const ccEnabled = (): boolean => settingsStore?.get().connectors.cc.enabled ?? true
  const syncCcCfgFiles = (): Promise<void> => {
    if (!ccEnabled() || server === null) return Promise.resolve()
    return writeCcHookConfigs(ccPaths.cfgDir, server.port).catch((error: unknown) => {
      console.error('[petween-cc] cfg sync failed', error)
    })
  }
  void syncCcCfgFiles()
  registerCcConnectorRoutes({ webServer: server.webServer }, {
    isEnabled: ccEnabled,
    onHookEvent: (input) => {
      ccConnector.handle(input)
      // Every event refreshes the dialogue registry — the transcript path
      // is right there in the payload (survives app restarts mid-session).
      if (input.payload?.transcriptPath !== undefined) {
        ccDialogueSource.noteTranscript(input.sessionId, input.payload.transcriptPath)
      }
    },
    connectorStatus: async () => ({
      ...ccConnector.status(),
      enabled: ccEnabled(),
      hooksInstalled: await ccHooksInstalled(ccPaths),
    }),
    installHooks: async () => {
      await syncCcCfgFiles()
      await installCcHooks(ccPaths)
    },
    uninstallHooks: async () => {
      await uninstallCcHooks(ccPaths)
    },
  })

  // DSH bridge lifecycle driven by the settings store (docs/05 Phase 4).
  let bridge: ReturnType<typeof createDshBridge> | null = null
  const startBridge = (): void => {
    if (bridge !== null || server === null) return
    bridge = createDshBridge({
      relay: server.relay,
      getPort: () => dshPortOf(settingsStore!.get()),
      connect: connectDshSocket,
      describe: describeDsh,
      log: (message) => console.log(message),
      onStatus: (status, detail) => {
        console.log(`[petween-dsh] ${status}${detail === undefined ? '' : ` (${detail})`}`)
        dshStatus = { connected: status === 'connected', detail }
        tray.update(trayState())
      },
    })
    bridge.start()
  }
  const stopBridge = (): void => {
    bridge?.close()
    bridge = null
    dshStatus = { connected: false, detail: 'disabled' }
    tray.update(trayState())
  }
  bridgeRestart = (next: DesktopSettings): void => {
    const shouldRun = next.dsh.enabled
    if (shouldRun && bridge === null) startBridge()
    else if (!shouldRun && bridge !== null) stopBridge()
    // Port changes are picked up by getPort() on the next reconnect cycle.
  }
  if (settings.dsh.enabled) startBridge()
  tray.update(trayState())

  // Live-apply settings: click-through options + rescue hotkey + bridge.
  let prevZcodeEnabled = settings.connectors.zcode.enabled
  settingsStore.onChange((next) => {
    pointerThrough?.updateOptions(pointerOptions(next))
    syncRescueHotkey(next)
    bridgeRestart?.(next)
    const zcodeNext = next.connectors.zcode.enabled
    if (zcodeNext && !prevZcodeEnabled) void syncZcodeCfgFiles()
    prevZcodeEnabled = zcodeNext
  })

  const overlay = createOverlayWindow()
  pointerThrough = attachPointerThrough(overlay, pointerOptions(settings))
  overlay.once('closed', () => {
    pointerThrough?.dispose()
    pointerThrough = null
  })
  syncRescueHotkey(settings)
  loadOverlayPage(overlay, {
    devUrl: process.env.ELECTRON_RENDERER_URL,
    serverPort: server.port,
  })

  app.on('quit', () => {
    if (rescueHotkey !== null) globalShortcut.unregister(rescueHotkey)
    physics.dispose()
    zcodeConnector.dispose()
    ccConnector.dispose()
    bridge?.close()
    tray.destroy()
    void server?.close().catch(() => {})
    settingsStore?.flushSync()
  })

  // TEMP repro hook (reverted after the quit-error diagnosis): auto-quit to
  // exercise the full quit path headlessly.
  if (process.env.PETWEEN_QUIT_AFTER_MS !== undefined) {
    setTimeout(() => app.quit(), Number(process.env.PETWEEN_QUIT_AFTER_MS))
  }

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
