/**
 * Regression tests for the stale-hoververdict flap (2026-09-14): a hoverHit
 * frozen at true (event delivery stalled over the pet) must degrade to false
 * once the backing mousemove ages past MOVE_FRESH_MS — otherwise the 1s
 * keep-alive re-asserts it forever and the whole overlay flaps between
 * interactive and click-through, eating clicks across the screen.
 */
import { describe, expect, it } from 'vitest'
import { effectiveHoverHit } from '../../src/renderer/overlay/pointer-signal'

describe('effectiveHoverHit', () => {
  it('passes a recent verdict through', () => {
    expect(effectiveHoverHit(true, 0)).toBe(true)
    expect(effectiveHoverHit(true, 599)).toBe(true)
    expect(effectiveHoverHit(false, 100)).toBe(false)
  })

  it('degrades a stale TRUE verdict to false (the flap bug)', () => {
    expect(effectiveHoverHit(true, 600)).toBe(false)
    expect(effectiveHoverHit(true, 60_000)).toBe(false) // stalled for a minute
    expect(effectiveHoverHit(true, Number.POSITIVE_INFINITY)).toBe(false) // never any move
  })
})
