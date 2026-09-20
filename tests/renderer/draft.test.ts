/**
 * draft.test.ts — jsonDeepEqual, the dirty-tracking primitive of the per-page
 * 取消/应用 model (Phase 18 settings rework). The settings document is plain
 * JSON, so these cases cover the shapes that can actually appear.
 */
import { describe, expect, it } from 'vitest'
import { jsonDeepEqual } from '../../src/renderer/settings/draft'

describe('jsonDeepEqual', () => {
  it('primitives compare by value; NaN-style identity is irrelevant here', () => {
    expect(jsonDeepEqual(1, 1)).toBe(true)
    expect(jsonDeepEqual('a', 'a')).toBe(true)
    expect(jsonDeepEqual(true, true)).toBe(true)
    expect(jsonDeepEqual(null, null)).toBe(true)
    expect(jsonDeepEqual(1, 2)).toBe(false)
    expect(jsonDeepEqual(1, '1')).toBe(false)
    expect(jsonDeepEqual(null, undefined)).toBe(false)
    expect(jsonDeepEqual(undefined, undefined)).toBe(true)
  })

  it('objects compare structurally regardless of key order', () => {
    expect(jsonDeepEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true)
    expect(jsonDeepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(jsonDeepEqual({ a: 1 }, { b: 1 })).toBe(false)
  })

  it('arrays compare element-wise and do not coerce against objects', () => {
    expect(jsonDeepEqual([1, 2], [1, 2])).toBe(true)
    expect(jsonDeepEqual([1, 2], [2, 1])).toBe(false)
    expect(jsonDeepEqual([1], { 0: 1 })).toBe(false)
    expect(jsonDeepEqual([], {})).toBe(false)
  })

  it('nested differences anywhere make the whole compare false', () => {
    expect(jsonDeepEqual({ companions: { options: { roamer: { wander: { enabled: true } } } } },
      { companions: { options: { roamer: { wander: { enabled: false } } } } })).toBe(false)
    expect(jsonDeepEqual({ connectors: { zcode: { enabled: true } } },
      { connectors: { zcode: { enabled: true, followLatestUser: false } } })).toBe(false)
  })
})
