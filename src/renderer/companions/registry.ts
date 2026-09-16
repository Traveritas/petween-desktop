/**
 * companions/registry.ts — the desktop companion host (docs/05 Phase 8).
 * A companion is a pet-behavior module running IN the overlay renderer next
 * to the pet stage (60fps position control must not cross IPC). The same
 * registry module is imported by the overlay entry (mount) and the settings
 * entry (list metadata) — keep module scope DOM-free and side-effect-free
 * except registration.
 *
 * Contract note: this interface is the CANONICAL shape; plugin repos mirror
 * it structurally (same discipline as petween-physics mirroring petween's
 * service types) so plugins never depend on this package.
 */
import type { ComponentType } from 'react'
import type { PetweenClientService } from 'petween/client/extension-service'

export interface DesktopCompanionContext {
  /** The shared petween extension-service singleton (snapshots/lease/anims). */
  petween: PetweenClientService
}

export interface DesktopCompanion {
  id: string
  displayName: string
  description?: string
  /** Optional settings UI the shell hosts in its 插件 section (Phase 8C). */
  readonly SettingsCard?: ComponentType
  init(ctx: DesktopCompanionContext): (() => void) | void
}

const registry: DesktopCompanion[] = []

export function registerCompanion(companion: DesktopCompanion): void {
  if (registry.some((existing) => existing.id === companion.id)) return
  registry.push(companion)
}

export function listCompanions(): readonly DesktopCompanion[] {
  return [...registry]
}

/**
 * Mounts every registered companion the predicate enables, with crash
 * isolation: one companion's init/dispose throwing must neither break the
 * others nor the overlay. Returns a disposer that unmounts everything
 * (used by the overlay's settings-poll remount cycle).
 */
export function mountEnabledCompanions(
  petween: PetweenClientService,
  isEnabled: (id: string) => boolean,
): () => void {
  const disposers: Array<() => void> = []
  for (const companion of registry) {
    if (!isEnabled(companion.id)) continue
    try {
      const dispose = companion.init({ petween })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      console.error(`[petween-desktop] companion "${companion.id}" failed to mount`, error)
    }
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        console.error('[petween-desktop] companion dispose threw', error)
      }
    }
  }
}
