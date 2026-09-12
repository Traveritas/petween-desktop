/**
 * pointer-signal.ts — renderer half of the click-through (docs/05 Phase 3).
 * Combines two data sources:
 *
 *  - petween StageSnapshot via the shared extension service (preferred:
 *    bodyRect is the pet's real hit region incl. anchor math, and `dragging`
 *    is authoritative), and
 *  - document.elementsFromPoint at the last cursor position (works before
 *    the session boots; the stage root carries the stable .petween-position
 *    class).
 *
 * Signals are throttled to ~20/s and force-flushed on snapshot pushes,
 * button transitions and a 1s keep-alive.
 */
import { petweenClientService } from 'petween/client/extension-service'

interface PointerSignal {
  bodyRect: { x: number; y: number; width: number; height: number } | null
  dragging: boolean
  hoverHit: boolean
  cursorClient: { x: number; y: number } | null
}

const THROTTLE_MS = 50
const KEEP_ALIVE_MS = 1000

export function startPointerSignal(): () => void {
  const current: PointerSignal = {
    bodyRect: null,
    dragging: false,
    hoverHit: false,
    cursorClient: null,
  }
  let lastSent = 0

  const report = window.petweenDesktop.pointerThrough.report
  const send = (force = false): void => {
    const now = performance.now()
    if (!force && now - lastSent < THROTTLE_MS) return
    lastSent = now
    report({ ...current, cursorClient: current.cursorClient === null ? null : { ...current.cursorClient } })
  }

  const hitTest = (x: number, y: number): boolean =>
    document
      .elementsFromPoint(x, y)
      .some((element) => element instanceof Element && element.closest('.petween-position') !== null)

  const onMouseMove = (event: MouseEvent): void => {
    current.cursorClient = { x: event.clientX, y: event.clientY }
    current.hoverHit = hitTest(event.clientX, event.clientY)
    send()
  }
  const onPointerDown = (event: PointerEvent): void => {
    current.cursorClient = { x: event.clientX, y: event.clientY }
    current.hoverHit = hitTest(event.clientX, event.clientY)
    send(true)
  }
  const onPointerUp = (): void => {
    send(true)
  }

  window.addEventListener('mousemove', onMouseMove, { passive: true })
  window.addEventListener('pointerdown', onPointerDown, { passive: true })
  window.addEventListener('pointerup', onPointerUp, { passive: true })

  const unsubscribeStage = petweenClientService.subscribeStage((snapshot) => {
    current.bodyRect = snapshot?.bodyRect ?? null
    current.dragging = snapshot?.dragging ?? false
    send(true)
  })

  const keepAlive = setInterval(() => send(true), KEEP_ALIVE_MS)

  return () => {
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('pointerup', onPointerUp)
    unsubscribeStage()
    clearInterval(keepAlive)
  }
}
