/**
 * roamer host assembly tests (docs/05 Phase 17): the factory wander
 * animations register into the real petween companion host service,
 * registration is idempotent, and a pre-existing (user-edited) definition
 * is never overwritten.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnimationsStore } from 'petween/host/animations'
import { createPetweenHostService } from 'petween/host/service'
import { createWriteLock } from 'petween/host/storage'
import { assembleRoamer, ensureRoamerAnimations } from '../../src/main/roamer-assembly'
import { ROAMER_ANIMATIONS, WALK_BOB_ANIMATION, WALK_BOB_ANIMATION_ID } from '../../src/renderer/companions/roamer/animations'

let dir: string
let animationsStore: AnimationsStore
let petweenHostService: ReturnType<typeof createPetweenHostService>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'petween-roamer-asm-'))
  animationsStore = new AnimationsStore({
    animationsDir: join(dir, 'animations'),
    lock: createWriteLock(),
  })
  petweenHostService = createPetweenHostService(animationsStore)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('assembleRoamer', () => {
  it('registers every factory animation into the shared library (fire-and-forget)', async () => {
    assembleRoamer({ petweenHostService })
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { customs } = await animationsStore.loadAll()
      if (customs.length >= ROAMER_ANIMATIONS.length) {
        for (const definition of ROAMER_ANIMATIONS) {
          expect(customs.some((entry) => entry.id === definition.id)).toBe(true)
        }
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('roamer animations never registered')
  })

  it('is idempotent — a second ensure does not duplicate entries', async () => {
    await ensureRoamerAnimations(petweenHostService)
    await ensureRoamerAnimations(petweenHostService)
    const { customs } = await animationsStore.loadAll()
    const matches = customs.filter((entry) => entry.id === WALK_BOB_ANIMATION_ID)
    expect(matches).toHaveLength(1)
  })

  it('never overwrites a user-edited definition with the factory default', async () => {
    await petweenHostService.registerAnimation({ ...WALK_BOB_ANIMATION, durationMs: 4321 })
    await ensureRoamerAnimations(petweenHostService)
    const { customs } = await animationsStore.loadAll()
    const found = customs.find((entry) => entry.id === WALK_BOB_ANIMATION_ID)
    expect(found?.durationMs).toBe(4321)
  })
})
