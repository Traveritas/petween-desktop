/**
 * Companion registry tests (docs/05 Phase 8A): registration, enable
 * predicate, crash isolation on init/dispose, and the settings-store
 * companions section roundtrip.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  listCompanions,
  mountEnabledCompanions,
  registerCompanion,
} from '../../src/renderer/companions/registry'
import { normalizeDesktopSettings } from '../../src/main/desktop-settings'
import type { DesktopCompanion } from '../../src/renderer/companions/registry'
import type { PetweenClientService } from 'petween/client/extension-service'

const petween = {} as PetweenClientService // registry never touches it in these tests

function fake(init: DesktopCompanion['init']): DesktopCompanion {
  return { id: `c${Math.random().toString(36).slice(2, 8)}`, displayName: 'C', init }
}

describe('registry', () => {
  it('registers once per id and lists them', () => {
    const companion = fake(() => {})
    registerCompanion(companion)
    registerCompanion({ ...companion, displayName: 'dup' })
    expect(listCompanions().filter((c) => c.id === companion.id)).toHaveLength(1)
  })

  it('mounts only enabled companions and runs their disposers', () => {
    const mounted: string[] = []
    const a = fake(() => {
      mounted.push('a-init')
      return () => mounted.push('a-dispose')
    })
    const b = fake(() => mounted.push('b-init'))
    registerCompanion(a)
    registerCompanion(b)
    const dispose = mountEnabledCompanions(petween, (id) => id === a.id)
    expect(mounted).toEqual(['a-init'])
    dispose()
    expect(mounted).toEqual(['a-init', 'a-dispose'])
    // dispose is idempotent
    dispose()
    expect(mounted).toEqual(['a-init', 'a-dispose'])
  })

  it('a throwing init neither breaks other companions nor leaks into dispose', () => {
    const order: string[] = []
    const boom = fake(() => {
      throw new Error('boom')
    })
    const ok = fake(() => () => order.push('ok-dispose'))
    registerCompanion(boom)
    registerCompanion(ok)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const dispose = mountEnabledCompanions(petween, () => true)
      dispose()
    } finally {
      errorSpy.mockRestore()
    }
    expect(order).toEqual(['ok-dispose'])
  })

  it('a throwing disposer is contained', () => {
    const bad = fake(() => () => {
      throw new Error('dispose boom')
    })
    const good = fake(() => () => {})
    registerCompanion(bad)
    registerCompanion(good)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const dispose = mountEnabledCompanions(petween, () => true)
      expect(() => dispose()).not.toThrow()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('desktop-settings companions section', () => {
  it('absent ids mean enabled; only booleans survive normalization', () => {
    const settings = normalizeDesktopSettings({
      companions: { enabled: { physics: false, other: 'yes', more: true } },
    })
    expect(settings.companions.enabled).toEqual({ physics: false, more: true })
    expect(normalizeDesktopSettings({}).companions.enabled).toEqual({})
  })
})
