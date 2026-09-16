/**
 * physics-assembly.ts — desktop assembly of the petween-physics host half
 * (docs/05 Phase 8C). Mirrors the DSH entry (src/index.ts) minus cordis:
 * the config store gets an explicit data path under userData, the config
 * route lands on the shared local-server table, and the factory-default
 * bounce animation registers through the petween companion host service
 * (idempotent, never overwrites user edits).
 *
 * Pure Node — unit-tested directly against a bare route table + the real
 * petween host service.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ensureBounceAnimation } from 'petween-physics/host/bounce-animation'
import { PhysicsConfigStore } from 'petween-physics/host/config'
import { registerConfigRoutes } from 'petween-physics/host/routes'
import type { PetweenHostService } from 'petween/host/service'

export interface PhysicsAssemblyOptions {
  host: { webServer: { register(route: WebRoute): () => void } }
  petweenHostService: PetweenHostService
  /** Absolute config.json path (userData/petween-physics/config.json). */
  configPath: string
}

export function assemblePhysics(options: PhysicsAssemblyOptions): { dispose(): void } {
  mkdirSync(dirname(options.configPath), { recursive: true })
  const store = new PhysicsConfigStore({ configPath: options.configPath })
  const disposeRoutes = registerConfigRoutes(options.host, {
    loadConfig: () => store.load(),
    updateConfig: (patch) => store.update(patch),
  })
  // Fire-and-forget like the DSH entry: the effect is optional eye candy.
  void ensureBounceAnimation(options.petweenHostService).catch((error: unknown) => {
    console.warn('[petween-physics] default bounce animation registration failed', error)
  })
  return { dispose: disposeRoutes }
}
