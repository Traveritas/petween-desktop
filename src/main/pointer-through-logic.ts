/**
 * pointer-through-logic.ts — the pure click-through decision (docs/04 §2,
 * docs/05 Phase 3). Two signals feed the AUTO mode:
 *
 *  1. renderer hit-test signals (mousemove via forwarded events; stale when
 *     focus is on another app and forwarding stalls — electron#33281), and
 *  2. the main-process cursor poll against the last reported pet body rect
 *     (screen space), which works even when forwarding is dead.
 *
 * AUTO decides: interactive (pet clickable) iff a fresh signal says
 * dragging/hover-hit, OR the cursor sits inside the pet's screen rect —
 * expanded by the hysteresis margin while already interactive so the edge
 * cannot flap. always-through is the forced escape for the stuck-interactive
 * bugs (#49982 / codex#41465 style wedges): it short-circuits the decision
 * but keeps tracking the rect so switching back to auto is instant.
 * (A forced always-interactive MODE was removed 2026-09-16 per user
 * decision: it swallowed every OS mouse click and duplicated the rescue
 * hotkey's momentary interactive lock.)
 *
 * No Electron imports; unit-tested directly.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type ClickThroughMode = 'auto' | 'always-through'

export interface PointerThroughOptions {
  mode: ClickThroughMode
  /** Hysteresis + hit margin around the body rect (px, DIP). */
  hitPaddingPx: number
}

export const DEFAULT_POINTER_OPTIONS: PointerThroughOptions = {
  mode: 'auto',
  hitPaddingPx: 6,
}

export interface PointerThroughState {
  interactive: boolean
  /** Last known client-space body rect (persists between renderer signals). */
  bodyRect: Rect | null
}

export interface RendererSignal {
  hoverHit: boolean
  dragging: boolean
  bodyRect: Rect | null
}

export interface DecisionInputs {
  now: number
  signalAt: number | null
  signal: RendererSignal | null
  cursorScreen: { x: number; y: number } | null
  /** Content-bounds origin of the overlay window (client → screen DIP). */
  contentOrigin: { x: number; y: number }
}

/** A renderer signal older than this may be a stalled forward (#33281). */
export const SIGNAL_FRESH_MS = 800
/** Dragging keeps authority a little longer — a mid-drag stall must not drop the gesture. */
export const DRAG_HOLD_MS = 2000

function pointInRect(point: { x: number; y: number }, rect: Rect, margin: number): boolean {
  return (
    point.x >= rect.x - margin &&
    point.x <= rect.x + rect.width + margin &&
    point.y >= rect.y - margin &&
    point.y <= rect.y + rect.height + margin
  )
}

export function decideInteractive(
  inputs: DecisionInputs,
  state: PointerThroughState,
  options: PointerThroughOptions = DEFAULT_POINTER_OPTIONS,
): PointerThroughState {
  const bodyRect = inputs.signal?.bodyRect ?? state.bodyRect

  if (options.mode === 'always-through') {
    return { interactive: false, bodyRect }
  }

  // AUTO: the cursor poll — works with zero renderer cooperation.
  let interactive = false
  if (bodyRect !== null && inputs.cursorScreen !== null) {
    const screenRect: Rect = {
      x: bodyRect.x + inputs.contentOrigin.x,
      y: bodyRect.y + inputs.contentOrigin.y,
      width: bodyRect.width,
      height: bodyRect.height,
    }
    const margin = state.interactive ? options.hitPaddingPx : 0
    interactive = pointInRect(inputs.cursorScreen, screenRect, margin)
  }

  // Fresh renderer signals refine the poll outcome.
  if (inputs.signalAt !== null && inputs.signal !== null) {
    const age = inputs.now - inputs.signalAt
    if (age <= SIGNAL_FRESH_MS && inputs.signal.hoverHit) interactive = true
    if (age <= DRAG_HOLD_MS && inputs.signal.dragging) interactive = true
    // A fresh hoverHit=false keeps the (hysteresis-qualified) poll verdict:
    // exiting is the poll's call, so transparent image margins near the body
    // do not flap the state.
  }

  return { interactive, bodyRect }
}
