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
