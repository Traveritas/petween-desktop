/**
 * Legacy flat option keys → per-type configs: an existing pick must keep its
 * exact look after the v0.3.4 restructure.
 */
import { describe, expect, it } from 'vitest'
import { migrateTypeConfigs } from '../../src/renderer/companions/stats-hud/companion'

describe('migrateTypeConfigs', () => {
  it('maps the v0.3.3 flat keys onto the new per-type shape', () => {
    const types = migrateTypeConfigs({
      styleId: 'terminal',
      replyStyleId: 'soft',
      turnStyleId: 'glass',
      enterAnimationId: 'rise',
      exitAnimationId: 'sink',
      thinkingHoldMs: 500,
      editHoldMs: 2500,
    })
    expect(types.thinking).toMatchObject({ styleId: 'terminal', enterAnimationId: 'rise', exitAnimationId: 'sink', holdMs: 500 })
    expect(types.edit).toMatchObject({ styleId: 'terminal', enterAnimationId: 'rise', exitAnimationId: 'sink', holdMs: 2500 })
    expect(types.reply).toMatchObject({ styleId: 'soft', enterAnimationId: 'rise', exitAnimationId: 'sink', holdMs: 7000 })
    expect(types.turn).toMatchObject({ styleId: 'glass', enterAnimationId: 'rise', exitAnimationId: 'sink', holdMs: 4000 })
  })

  it('explicit types win over the legacy mapping', () => {
    const types = migrateTypeConfigs({
      styleId: 'terminal',
      types: { thinking: { styleId: 'soft', holdMs: 300 } },
    })
    expect(types.thinking).toMatchObject({ styleId: 'soft', holdMs: 300 })
    expect(types.edit.styleId).toBe('terminal')
  })

  it('defaults holds when nothing is stored', () => {
    const types = migrateTypeConfigs(undefined)
    expect(types.thinking.holdMs).toBe(900)
    expect(types.edit.holdMs).toBe(1500)
    expect(types.turn.holdMs).toBe(4000)
    expect(types.reply.holdMs).toBe(7000)
    expect(types.thinking.styleId).toBeUndefined()
  })

  it('v0.2.2/0.2.3 bundled animationId migrates to enter=itself, exit=its bundled exit', () => {
    // Regression (v0.4.0 review): the migration existed in v0.2.5
    // (cf78964) but was dropped in the v0.3.x restructure — upgrades from
    // ≤0.2.3 silently fell back to default animations.
    const rise = migrateTypeConfigs({ animationId: 'rise' })
    expect(rise.thinking).toMatchObject({ enterAnimationId: 'rise', exitAnimationId: 'sink' })
    expect(rise.reply.exitAnimationId).toBe('sink')

    const pop = migrateTypeConfigs({ animationId: 'pop' })
    expect(pop.thinking).toMatchObject({ enterAnimationId: 'pop', exitAnimationId: 'fade' })

    const drop = migrateTypeConfigs({ animationId: 'drop' })
    expect(drop.thinking).toMatchObject({ enterAnimationId: 'drop', exitAnimationId: 'fade' })
  })

  it('explicit enter/exit keys win over the bundled animationId', () => {
    const types = migrateTypeConfigs({ animationId: 'pop', enterAnimationId: 'rise', exitAnimationId: 'drift' })
    expect(types.thinking).toMatchObject({ enterAnimationId: 'rise', exitAnimationId: 'drift' })
  })
})
