/**
 * Column slot assignment: focused session above the pet, the rest flanking
 * by recency (left first). Pure function, no DOM.
 */
import { describe, expect, it } from 'vitest'
import { assignColumnSlots, packColumnBand } from '../../src/renderer/companions/bubbles/bubble-host'

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

describe('packColumnBand (edge-packed, pet-centered, clamp-first)', () => {
  const cols = [
    { key: 'a', width: 100, slot: -1 },
    { key: 'focus', width: 100, slot: 0 },
    { key: 'b', width: 100, slot: 1 },
  ]

  it('centers the whole band on the pet with exact border gaps', () => {
    const centers = packColumnBand(cols, 1000, 24, 2048, 6)
    // total = 300 + 2*24 = 348 → startX = 1000 - 174 = 826
    expect(centers.get('a')).toBe(876)
    expect(centers.get('focus')).toBe(1000)
    expect(centers.get('b')).toBe(1124)
  })

  it('shifts the band inward when it would overflow the viewport', () => {
    // pet near the right edge: centered start would run off-screen.
    const centers = packColumnBand(cols, 1900, 24, 2048, 6)
    const startX = Math.min(Math.max(1900 - 174, 6), 2048 - 6 - 348) // = 1694
    expect(centers.get('a')).toBe(startX + 50)
    expect(centers.get('focus')).toBe(startX + 174)
    expect(centers.get('b')).toBe(startX + 298)
    // every column fully inside the viewport
    for (const center of centers.values()) {
      expect(center - 50).toBeGreaterThanOrEqual(6)
      expect(center + 50).toBeLessThanOrEqual(2048 - 6)
    }
  })

  it('anchors left when the band is wider than the viewport', () => {
    const wide = [
      { key: 'w1', width: 1100, slot: -1 },
      { key: 'w2', width: 1100, slot: 0 },
    ]
    const centers = packColumnBand(wide, 1000, 24, 2048, 6)
    expect(centers.get('w1')).toBe(556) // startX = 6 → 6 + 550
    expect(centers.get('w2')).toBe(6 + 1100 + 24 + 550)
  })

  it('empty input yields no centers', () => {
    expect(packColumnBand([], 500, 24, 1000, 6).size).toBe(0)
  })
})
