/**
 * local-server.ts — assembles the petween host halves onto a node:http server
 * (docs/02 §2, assembly template = vendor/petween/src/index.ts:57-99):
 * four stores on ONE shared write lock under an explicit data root,
 * preset-authority migration BEFORE any store exists, the routes, the state
 * channel and the editor page with an injected bundle loader.
 *
 * Every path is injected — the module itself never touches Electron, so the
 * full assembly boots under vitest/node.
 */
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { AnimationsStore } from 'petween/host/animations'
import { AssetStore } from 'petween/host/assets'
import { ConfigStore } from 'petween/host/config'
import { ConfigViewStore } from 'petween/host/view-store'
import { createWriteLock } from 'petween/host/storage'
import { registerAnimatorPage } from 'petween/host/animator-page'
import { registerEditorPage } from 'petween/host/editor-page'
import { PetsStore } from 'petween/host/pets'
import { planMotionPackImport } from 'petween/host/packs'
import { registerRoutes, type RoutesDeps } from 'petween/host/routes'
import { attachStateChannel, type StateChannel } from 'petween/host/state-channel'
import { ensurePresetAuthority } from 'petween/host/migrate-v2'
import { createPetweenHostService, type PetweenHostService } from 'petween/host/service'
import { createRouteTable } from './routes-host'
import { createStateRelay, type StateRelay } from './state-relay'
import { registerOverlayStatic } from './overlay-static'

export interface LocalServerOptions {
  /** Independent data root (userData/petween-home); structure mirrors $DSH_HOME/petween/. */
  dataRoot: string
  /** Absolute path to the prebuilt vendor/petween/lib/editor.js. */
  editorBundlePath: string
  /** Absolute path to the prebuilt vendor/petween/lib/animator.js (Phase 11). */
  animatorBundlePath: string
  /**
   * electron-vite renderer build dir (out/renderer). When set, the server
   * also serves the overlay page + hashed assets so the prod overlay window
   * stays same-origin with the API (docs/02 §1). Dev omits it — the overlay
   * loads from the vite dev server through the proxy instead.
   */
  rendererDistDir?: string
  /** 0/undefined = OS-assigned random port (prod); dev passes a fixed port. */
  port?: number
}

export interface PetweenLocalServer {
  readonly port: number
  readonly relay: StateRelay
  readonly stateChannel: StateChannel
  /** Register shell-owned routes (e.g. /api/petween-desktop/*) on the same table. */
  readonly webServer: { register(route: WebRoute): () => void }
  /**
   * The petween companion host service — companion plugins (petween-physics)
   * register shared animations through it. Exposed since Phase 8.
   */
  readonly petweenHostService: PetweenHostService
  close(): Promise<void>
}

export async function startPetweenLocalServer(options: LocalServerOptions): Promise<PetweenLocalServer> {
  const root = options.dataRoot
  // Preset authority BEFORE any store exists (same order as petween index.ts):
  // a store constructed first would race the v1→v2 migration with defaults.
  ensurePresetAuthority(root)

  // B10: ONE write lock shared by every store.
  const sharedWriteLock = createWriteLock()
  const animationsStore = new AnimationsStore({
    animationsDir: join(root, 'animations'),
    lock: sharedWriteLock,
  })
  const petsStore = new PetsStore({ petsDir: join(root, 'pets'), lock: sharedWriteLock })
  const configStore = new ConfigStore({
    configPath: join(root, 'config.json'),
    lock: sharedWriteLock,
    animationLookup: (id) => animationsStore.kindOf(id),
  })
  const viewStore = new ConfigViewStore({
    configStore,
    petsStore,
    animationLookup: (id) => animationsStore.kindOf(id),
  })
  const assetStore = new AssetStore({
    assetsDir: join(root, 'assets'),
    manifestPath: join(root, 'assets.json'),
    lock: sharedWriteLock,
  })

  const deps: RoutesDeps = {
    loadConfig: () => viewStore.loadView(),
    updateConfig: (patch, updateOptions) => viewStore.update(patch, updateOptions),
    configRevision: () => viewStore.revision(),
    listAssets: () => assetStore.list(),
    saveAsset: (buffer, declaredMime) => assetStore.save(buffer, declaredMime),
    deleteAsset: (id, referencedBy) => assetStore.delete(id, referencedBy),
    resolveAssetPath: (id) => assetStore.resolve(id),
    maxAssetBytes: assetStore.maxFileBytes,
    listAnimations: () => animationsStore.loadAll(),
    saveAnimation: (definition, guard) => animationsStore.save(definition, guard),
    deleteAnimation: (id, referencedBy) => animationsStore.delete(id, referencedBy),
    importPack: (pack) =>
      animationsStore.importAnimations((existing) => planMotionPackImport(pack, existing)),
    listPets: () => petsStore.list(),
    createPet: (name, slice, attribution, pluginConfigs) =>
      petsStore.create(name, slice, attribution, pluginConfigs),
    readPet: (id) => petsStore.read(id),
    updatePetMeta: (id, changes) => petsStore.updateMeta(id, changes),
    deletePet: (id) => petsStore.delete(id),
  }

  const table = createRouteTable()
  const disposeRoutes = registerRoutes(table.host, deps)
  // Deep-imported host code cannot resolve lib/*.js via import.meta.url
  // (it points into vendor/petween/src) — the bundle loaders must be injected.
  const disposeEditor = registerEditorPage(table.host, {
    loadBundle: () => readFile(options.editorBundlePath),
  })
  const disposeAnimator = registerAnimatorPage(table.host, {
    loadBundle: () => readFile(options.animatorBundlePath),
  })
  const disposeOverlayStatic =
    options.rendererDistDir === undefined
      ? null
      : registerOverlayStatic(table.host, options.rendererDistDir)
  const relay = createStateRelay(table.host.webServer)
  const stateChannel = attachStateChannel(relay.host)
  // The companion host service (Phase 8): petween-physics registers its
  // default bounce animation through this — same call the DSH entry makes.
  const petweenHostService = createPetweenHostService(animationsStore)

  const server = createServer(table.handleRequest)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject) // EADDRINUSE/EACCES must reject, not crash
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })

  let closed = false
  return {
    port: (server.address() as AddressInfo).port,
    relay,
    stateChannel,
    webServer: table.host.webServer,
    petweenHostService,
    close: () => {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise<void>((resolve, reject) => {
        stateChannel.dispose()
        disposeAnimator()
        disposeEditor()
        disposeOverlayStatic?.()
        disposeRoutes()
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    },
  }
}
