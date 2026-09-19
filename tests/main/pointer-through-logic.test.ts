/**
 * Click-through decision tests (docs/05 Phase 3): the pure logic only —
 * renderer hit authority, cursor-poll fallback (#33281), hysteresis, drag
 * hold, and client→screen rect mapping.
 */
import { describe, expect, it } from 'vitest'
import {
  DRAG_HOLD_MS,
  SIGNAL_FRESH_MS,
  decideInteractive,
  type PointerThroughState,
} from '../../src/main/pointer-through-logic'

const RECT = { x: 600, y: 400, width: 96, height: 96 }
const THROUGH: PointerThroughState = { interactive: false, near: false, bodyRect: null }

function inputs(overrides: Partial<Parameters<typeof decideInteractive>[0]> = {}) {
  return {
    now: 1_000_000,
    signalAt: null,
    signal: null,
    cursorScreen: { x: 0, y: 0 },
    contentOrigin: { x: 0, y: 0 },
    ...overrides,
  }
}

/** The default margin (DEFAULT_POINTER_OPTIONS.hitPaddingPx). */
const DEFAULT_MARGIN_PX = 6

describe('defaults', () => {
  it('no signal and no rect → click-through', () => {
    expect(decideInteractive(inputs({ cursorScreen: null }), THROUGH).interactive).toBe(false)
  })

  it('keeps the last known rect across signals without one', () => {
    const first = decideInteractive(
      inputs({ signal: { hoverHit: true, dragging: false, bodyRect: RECT }, signalAt: 1_000_000 }),
      THROUGH,
    )
    expect(first.bodyRect).toEqual(RECT)
    const second = decideInteractive(
      inputs({ signal: { hoverHit: false, dragging: false, bodyRect: null }, signalAt: 1_000_000 }),
      first,
    )
    expect(second.bodyRect).toEqual(RECT)
  })
})

describe('renderer hit authority', () => {
  it('fresh hover-hit → interactive even without a rect', () => {
    const state = decideInteractive(
      inputs({ signal: { hoverHit: true, dragging: false, bodyRect: null }, signalAt: 1_000_000 }),
      THROUGH,
    )
    expect(state.interactive).toBe(true)
  })

  it('stale hover-hit (stalled forward) is ignored on its own', () => {
    const state = decideInteractive(
      inputs({
        now: 1_000_000 + SIGNAL_FRESH_MS + 1,
        signal: { hoverHit: true, dragging: false, bodyRect: null },
        signalAt: 1_000_000,
        cursorScreen: null,
      }),
      THROUGH,
    )
    expect(state.interactive).toBe(false)
  })
})

describe('cursor poll fallback (#33281)', () => {
  it('cursor inside the screen rect → interactive with no renderer signal at all', () => {
    const state = decideInteractive(
      inputs({
        signal: { hoverHit: false, dragging: false, bodyRect: RECT },
        signalAt: null,
        cursorScreen: { x: 648, y: 448 },
      }),
      THROUGH,
    )
    expect(state.interactive).toBe(true)
  })

  it('maps the client rect through the content origin', () => {
    const state = decideInteractive(
      inputs({
        signal: { hoverHit: false, dragging: false, bodyRect: RECT },
        signalAt: null,
        cursorScreen: { x: 1648, y: 448 }, // 648 + 1000 origin shift
        contentOrigin: { x: 1000, y: 0 },
      }),
      THROUGH,
    )
    expect(state.interactive).toBe(true)
  })

  it('cursor far outside → stays through', () => {
    const state = decideInteractive(
      inputs({
        signal: { hoverHit: false, dragging: false, bodyRect: RECT },
        signalAt: 1_000_000,
        cursorScreen: { x: 100, y: 100 },
      }),
      THROUGH,
    )
    expect(state.interactive).toBe(false)
  })
})

describe('hysteresis', () => {
  const inside = inputs({
    signal: { hoverHit: false, dragging: false, bodyRect: RECT },
    signalAt: null,
    cursorScreen: { x: 648, y: 448 },
  })

  it('stays interactive just past the tight edge', () => {
    const entered = decideInteractive(inside, THROUGH)
    expect(entered.interactive).toBe(true)
    const pastEdge = decideInteractive(
      inputs({
        signal: { hoverHit: false, dragging: false, bodyRect: RECT },
        signalAt: null,
        cursorScreen: { x: RECT.x + RECT.width + DEFAULT_MARGIN_PX - 1, y: 448 },
      }),
      entered,
    )
    expect(pastEdge.interactive).toBe(true)
  })

  it('drops beyond the margin', () => {
    const entered = decideInteractive(inside, THROUGH)
    const beyond = decideInteractive(
      inputs({
        signal: { hoverHit: false, dragging: false, bodyRect: RECT },
        signalAt: null,
        cursorScreen: { x: RECT.x + RECT.width + DEFAULT_MARGIN_PX + 2, y: 448 },
      }),
      entered,
    )
    expect(beyond.interactive).toBe(false)
  })

  it('a non-interactive state needs the TIGHT rect to enter', () => {
    const nearMiss = decideInteractive(
      inputs({
        signal: { hoverHit: false, dragging: false, bodyRect: RECT },
        signalAt: null,
        cursorScreen: { x: RECT.x + RECT.width + DEFAULT_MARGIN_PX - 1, y: 448 },
      }),
      THROUGH,
    )
    expect(nearMiss.interactive).toBe(false)
  })
})

describe('forced modes (stuck-state escapes)', () => {
  it('always-through ignores hover, drag and cursor-in-rect', () => {
    const forced = { mode: 'always-through' as const, hitPaddingPx: 6 }
    const state = decideInteractive(
      inputs({
        signal: { hoverHit: true, dragging: true, bodyRect: RECT },
        signalAt: 1_000_000,
        cursorScreen: { x: 648, y: 448 },
      }),
      THROUGH,
      forced,
    )
    expect(state.interactive).toBe(false)
    expect(state.bodyRect).toEqual(RECT) // still tracked for an instant return to auto
  })
})

describe('hit padding option', () => {
  it('wider padding holds interactivity further out', () => {
    const entered = decideInteractive(
      inputs({
        signal: { hoverHit: false, dragging: false, bodyRect: RECT },
        signalAt: null,
        cursorScreen: { x: 648, y: 448 },
      }),
      THROUGH,
    )
    expect(entered.interactive).toBe(true)

    const cursorPastTightEdge = inputs({
      signal: { hoverHit: false, dragging: false, bodyRect: RECT },
      signalAt: null,
      cursorScreen: { x: RECT.x + RECT.width + 15, y: 448 },
    })
    // default 6px margin: dropped
    expect(decideInteractive(cursorPastTightEdge, entered).interactive).toBe(false)
    // 20px margin: still held
    expect(decideInteractive(cursorPastTightEdge, entered, { mode: 'auto', hitPaddingPx: 20 }).interactive).toBe(true)
  })
})

describe('drag hold', () => {
  it('dragging keeps interactivity even with hoverHit false', () => {
    const state = decideInteractive(
      inputs({
        signal: { hoverHit: false, dragging: true, bodyRect: null },
        signalAt: 1_000_000,
        cursorScreen: null,
      }),
      { interactive: true, bodyRect: RECT },
    )
    expect(state.interactive).toBe(true)
  })

  it('dragging is honored for longer than a plain signal, then dropped', () => {
    const staleHover = decideInteractive(
      inputs({
        now: 1_000_000 + SIGNAL_FRESH_MS + 1,
        signal: { hoverHit: true, dragging: true, bodyRect: null },
        signalAt: 1_000_000,
        cursorScreen: null,
      }),
      { interactive: true, bodyRect: null },
    )
    expect(staleHover.interactive).toBe(true)

    const dead = decideInteractive(
      inputs({
        now: 1_000_000 + DRAG_HOLD_MS + 1,
        signal: { hoverHit: false, dragging: true, bodyRect: null },
        signalAt: 1_000_000,
        cursorScreen: null,
      }),
      { interactive: true, bodyRect: null },
    )
    expect(dead.interactive).toBe(false)
  })
})

describe('forward band (near)', () => {
  // The band governs whether the mouse-forwarding hook may stay installed:
  // near the pet only (the hook is the known sibling-window cursor-flicker
  // trigger, so it must not live app-lifetime).
  const withRect = (cursorX: number, cursorY: number, state: PointerThroughState = THROUGH) =>
    decideInteractive(
      inputs({ cursorScreen: { x: cursorX, y: cursorY }, signal: { hoverHit: false, dragging: false, bodyRect: RECT } }),
      state,
    )

  it('inside the pet rect → near (forwarding allowed)', () => {
    expect(withRect(RECT.x + RECT.width / 2, RECT.y + RECT.height / 2).near).toBe(true)
  })

  it('inside the enter margin (96px) but outside the rect → near, not interactive', () => {
    const state = withRect(RECT.x - 80, RECT.y + RECT.height / 2)
    expect(state.near).toBe(true)
    expect(state.interactive).toBe(false)
  })

  it('beyond the enter margin → not near (pure click-through, no hook)', () => {
    expect(withRect(RECT.x - 200, RECT.y).near).toBe(false)
  })

  it('hysteresis: near survives until the wider exit margin (128px)', () => {
    const near = withRect(RECT.x - 80, RECT.y) // entered the band
    expect(near.near).toBe(true)
    // between enter (96) and exit (128): still near while already near
    expect(withRect(RECT.x - 110, RECT.y, near).near).toBe(true)
    // past the exit margin: band released
    expect(withRect(RECT.x - 200, RECT.y, near).near).toBe(false)
    // and re-entering requires the tighter enter margin again
    expect(withRect(RECT.x - 110, RECT.y, withRect(RECT.x - 200, RECT.y, near)).near).toBe(false)
  })

  it('no rect or no cursor → never near', () => {
    expect(decideInteractive(inputs({ cursorScreen: null }), THROUGH).near).toBe(false)
    expect(decideInteractive(inputs(), THROUGH).near).toBe(false)
  })

  it('always-through never enters the band (no hook in that mode)', () => {
    const state = decideInteractive(
      inputs({
        cursorScreen: { x: RECT.x + 48, y: RECT.y + 48 },
        signal: { hoverHit: false, dragging: false, bodyRect: RECT },
      }),
      THROUGH,
      { mode: 'always-through', hitPaddingPx: 6 },
    )
    expect(state.near).toBe(false)
    expect(state.interactive).toBe(false)
  })

  it('a fresh hover signal proves proximity (near even without the poll)', () => {
    const state = decideInteractive(
      inputs({ signal: { hoverHit: true, dragging: false, bodyRect: null }, signalAt: 1_000_000 }),
      THROUGH,
    )
    expect(state.near).toBe(true)
  })
})
