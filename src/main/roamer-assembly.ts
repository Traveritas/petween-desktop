/**
 * roamer-assembly.ts — desktop assembly of the roamer companion's host
 * half (docs/05 Phase 17): one-time registration of the factory-default
 * motion animations into the petween shared library. No config store, no
 * routes — everything user-editable lives in the shell's companions
 * options bag, and content/pose images ride the existing asset upload
 * pipeline, so the builder config and dev proxy stay untouched.
 *
 * Pure Node — unit-tested against the real petween host service.
 */
import type { PetweenHostService } from 'petween/host/service'
import { ROAMER_ANIMATIONS } from '../renderer/companions/roamer/animations'

export interface RoamerAssemblyOptions {
  petweenHostService: PetweenHostService
}

/**
 * First-install guard per animation: register a factory default only when
 * the library does not already hold it (the user's editor edit outranks
 * our default — the petween-physics ensureBounceAnimation discipline).
 */
export async function ensureRoamerAnimations(
  service: Pick<PetweenHostService, 'hasAnimation' | 'registerAnimation'>,
): Promise<void> {
  for (const definition of ROAMER_ANIMATIONS) {
    if (await service.hasAnimation(definition.id)) continue
    await service.registerAnimation(definition)
  }
}

export function assembleRoamer(options: RoamerAssemblyOptions): { dispose(): void } {
  // Fire-and-forget like the physics assembly: the walk bob is optional
  // eye candy; a failed registration only costs the visual.
  void ensureRoamerAnimations(options.petweenHostService).catch((error: unknown) => {
    console.warn('[petween-desktop] roamer default animation registration failed', error)
  })
  return { dispose: () => {} }
}
