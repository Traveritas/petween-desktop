/**
 * Column slot assignment: focused session above the pet, the rest flanking
 * by recency (left first). Pure function, no DOM.
 */
import { describe, expect, it } from 'vitest'
import { assignColumnSlots } from '../../src/renderer/companions/bubbles/bubble-host'

describe('assignColumnSlots', () => {
  it('focused session gets the center column, others flank by recency', () => {
    const slots = assignColumnSlots(
      [
        { key: 'old', lastActiveAt: 1 },
        { key: 'focus', lastActiveAt: 5 },
        { key: 'mid', lastActiveAt: 3 },
        { key: 'new', lastActiveAt: 9 },
      ],
      'focus',
    )
    expect(slots.get('focus')).toBe(0)
    // Recency order after focus: new (9), mid (3), old (1) → left, right, left.
    expect(slots.get('new')).toBe(-1)
    expect(slots.get('mid')).toBe(1)
    expect(slots.get('old')).toBe(-2)
  })

  it('unknown focus falls back to the most recent session', () => {
    const slots = assignColumnSlots(
      [
        { key: 'a', lastActiveAt: 1 },
        { key: 'b', lastActiveAt: 2 },
      ],
      'missing',
    )
    expect(slots.get('b')).toBe(0)
    expect(slots.get('a')).toBe(-1)
  })

  it('empty input yields no slots', () => {
    expect(assignColumnSlots([], null).size).toBe(0)
  })
})

describe('assignColumnSlots with room (pet near a screen edge)', () => {
  const sessions = [
    { key: 'old', lastActiveAt: 1 },
    { key: 'focus', lastActiveAt: 5 },
    { key: 'mid', lastActiveAt: 3 },
    { key: 'new', lastActiveAt: 9 },
  ]

  it('all side columns go inward when one side has no room', () => {
    // Pet parked at the right edge: 1800px left, 50px right.
    const slots = assignColumnSlots(sessions, 'focus', { leftPx: 1800, rightPx: 50, stridePx: 200 })
    expect(slots.get('focus')).toBe(0)
    expect(slots.get('new')).toBe(-1)
    expect(slots.get('mid')).toBe(-2)
    expect(slots.get('old')).toBe(-3)
  })

  it('balances both sides when both have room', () => {
    const slots = assignColumnSlots(sessions, 'focus', { leftPx: 1000, rightPx: 1200, stridePx: 200 })
    // new → right (1200>1000, right 1000); mid → right again? left(1000) vs right(1000) → tie goes LEFT (left>=right).
    expect(slots.get('new')).toBe(1)
    expect(slots.get('mid')).toBe(-1)
    expect(slots.get('old')).toBe(2) // left 800 vs right 1000 → right (+2)
  })

  it('spills to the roomier side when the tight side runs out', () => {
    const slots = assignColumnSlots(sessions, 'focus', { leftPx: 500, rightPx: 2000, stridePx: 200 })
    // new: right (2000>500) → +1 (right 1800); mid: right again (1800>500) → +2; old: right (1600>500) → +3.
    expect(slots.get('new')).toBe(1)
    expect(slots.get('mid')).toBe(2)
    expect(slots.get('old')).toBe(3)
  })
})
