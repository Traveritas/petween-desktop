/**
 * Sticky column slots (position memory): a session KEEPS its slot while its
 * column lives — activity order no longer reorders columns (the ping-pong
 * the user reported). Newcomers reuse freed slots (closest to center first),
 * so a returning session usually lands back where it was.
 */
import { describe, expect, it } from 'vitest'
import { assignStickySlots, packColumnBand } from '../../src/renderer/companions/bubbles/bubble-host'

describe('assignStickySlots', () => {
  it('first appearance: most recent gets the center, others alternate outward', () => {
    const { slots, memory } = assignStickySlots(new Map(), [
      { key: 'old', lastActiveAt: 1 },
      { key: 'mid', lastActiveAt: 3 },
      { key: 'new', lastActiveAt: 9 },
    ])
    expect(slots.get('new')).toBe(0)
    expect(slots.get('mid')).toBe(-1)
    expect(slots.get('old')).toBe(1)
    expect(memory).toEqual(slots)
  })

  it('slots are STICKY: recency flips do not reorder columns', () => {
    const first = assignStickySlots(new Map(), [
      { key: 'a', lastActiveAt: 10 },
      { key: 'b', lastActiveAt: 5 },
    ])
    const flipped = assignStickySlots(first.memory, [
      { key: 'a', lastActiveAt: 1 },
      { key: 'b', lastActiveAt: 99 },
    ])
    expect(flipped.slots.get('a')).toBe(first.slots.get('a'))
    expect(flipped.slots.get('b')).toBe(first.slots.get('b'))
  })

  it('newcomers reuse freed slots, closest to center first', () => {
    // a(0) b(-1) c(1); b's column dies; d arrives → takes b's freed -1.
    const first = assignStickySlots(new Map(), [
      { key: 'a', lastActiveAt: 30 },
      { key: 'b', lastActiveAt: 20 },
      { key: 'c', lastActiveAt: 10 },
    ])
    expect(first.slots.get('b')).toBe(-1)
    const after = assignStickySlots(first.memory, [
      { key: 'a', lastActiveAt: 31 },
      { key: 'c', lastActiveAt: 11 },
      { key: 'd', lastActiveAt: 99 },
    ])
    expect(after.slots.get('a')).toBe(0)
    expect(after.slots.get('c')).toBe(1)
    expect(after.slots.get('d')).toBe(-1)
  })

  it('a returning session lands back in its old slot when free', () => {
    const first = assignStickySlots(new Map(), [
      { key: 'a', lastActiveAt: 30 },
      { key: 'b', lastActiveAt: 20 },
    ])
    const withoutB = assignStickySlots(first.memory, [{ key: 'a', lastActiveAt: 31 }])
    const back = assignStickySlots(withoutB.memory, [
      { key: 'a', lastActiveAt: 31 },
      { key: 'b', lastActiveAt: 99 },
    ])
    expect(back.slots.get('b')).toBe(first.slots.get('b'))
  })

  it('memory drops departed sessions', () => {
    const first = assignStickySlots(new Map(), [{ key: 'a', lastActiveAt: 1 }, { key: 'b', lastActiveAt: 2 }])
    const after = assignStickySlots(first.memory, [{ key: 'a', lastActiveAt: 3 }])
    expect(after.memory.has('b')).toBe(false)
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
    const centers = packColumnBand(cols, 1900, 24, 2048, 6)
    const startX = Math.min(Math.max(1900 - 174, 6), 2048 - 6 - 348) // = 1694
    expect(centers.get('a')).toBe(startX + 50)
    expect(centers.get('focus')).toBe(startX + 174)
    expect(centers.get('b')).toBe(startX + 298)
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
