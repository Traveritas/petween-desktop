/**
 * roamer/windows.ts — the mischief content layer (docs/05 Phase 17 batch 3):
 * the pulled-out content windows and sticky notes the pet drags onto the
 * desktop. BubbleHost's skeleton applied to a different shape — a fixed,
 * pointer-events:none layer (click-through untouched), spawn → linger →
 * exit-class → timer removal, viewport clamping, and a dispose that clears
 * every timer. Below the bubble layer so stats/dialogue bubbles always win.
 *
 * Two placements:
 *  - pull: anchored near the pet, sliding in FROM the screen edge the pet
 *    walked to (CSS keyframes; DOM is not bound by the §27 stage clamp);
 *  - note: a small sticky at a random band position with a slight tilt.
 *
 * jsdom-testable: no WAAPI, class/timer driven like the bubble layer
 * (jsdom runs no CSS animations; tests assert classes + removal timing).
 */
import type { RoamerContentItem } from './types'

export type PullEdge = 'left' | 'right'
export type MischiefWindowKind = 'pull' | 'note'

export interface RoamerWindowSpawn {
  kind: MischiefWindowKind
  /** Which screen edge a 'pull' slides in from (ignored by 'note'). */
  edge?: PullEdge
  content: RoamerContentItem
  /** The pet's viewport position at spawn time ('pull' anchors near it). */
  anchor: { x: number; y: number; height: number }
  viewport: { width: number; height: number }
}

export interface RoamerWindowHandle {
  readonly el: HTMLElement
  readonly closed: boolean
  /** Start the exit fade; the element is removed afterwards. Idempotent. */
  close(): void
}

export interface RoamerWindowHost {
  spawn(spec: RoamerWindowSpawn): RoamerWindowHandle
  closeAll(): void
  dispose(): void
}

/** Linger before the fade: a pulled window is a scene, a note is a fixture. */
const PULL_LINGER_MS = 25000
const NOTE_LINGER_MS = 90000
const EXIT_FADE_MS = 600

const BASE_CSS = `
.pt-roamer-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147280000; }
.pt-roamer-win {
  position: absolute; max-width: 300px; border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  font: 13px/1.5 system-ui, 'Segoe UI', sans-serif; color: #222;
  background: #fdfdfb; overflow: hidden;
}
.pt-roamer-win img { display: block; max-width: 300px; max-height: 38vh; object-fit: contain; }
.pt-roamer-win__text { padding: 10px 12px; white-space: pre-wrap; word-break: break-word; }
.pt-roamer-win__caption {
  padding: 4px 10px 6px; font-size: 11px; color: #666;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
}
.pt-roamer-win--note { max-width: 190px; background: #fff8c4; border-radius: 2px; }
.pt-roamer-win--note .pt-roamer-win__text { font-family: KaiTi, 'Kaiti SC', cursive; }
@keyframes pt-roamer-slide-left {
  from { transform: translateX(calc(-100% - 32px)); }
  to { transform: translateX(0); }
}
@keyframes pt-roamer-slide-right {
  from { transform: translateX(calc(100% + 32px)); }
  to { transform: translateX(0); }
}
@keyframes pt-roamer-pop {
  from { transform: scale(0.6); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
@keyframes pt-roamer-fade {
  from { opacity: 1; }
  to { opacity: 0; }
}
.pt-roamer-enter-left { animation: pt-roamer-slide-left 340ms cubic-bezier(0.2, 0.9, 0.3, 1.1) both; }
.pt-roamer-enter-right { animation: pt-roamer-slide-right 340ms cubic-bezier(0.2, 0.9, 0.3, 1.1) both; }
.pt-roamer-enter-pop { animation: pt-roamer-pop 260ms ease-out both; }
.pt-roamer-exit { animation: pt-roamer-fade 600ms ease-in both; }
`

export function createRoamerWindowHost(): RoamerWindowHost {
  const container = document.createElement('div')
  container.className = 'pt-roamer-layer'
  const style = document.createElement('style')
  style.setAttribute('data-pt-roamer-windows', 'base')
  style.textContent = BASE_CSS
  document.head.appendChild(style)
  document.body.appendChild(container)

  const timers = new Set<ReturnType<typeof setTimeout>>()
  const entries: Array<{ el: HTMLElement; timer: ReturnType<typeof setTimeout> | null }> = []
  let disposed = false

  const later = (fn: () => void, delayMs: number): void => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, delayMs)
    timers.add(timer)
  }

  const detach = (entry: { el: HTMLElement }): void => {
    const index = entries.indexOf(entry as never)
    if (index >= 0) entries.splice(index, 1)
    entry.el.remove()
  }

  const render = (el: HTMLElement, content: RoamerContentItem): void => {
    if (content.kind === 'image') {
      const img = document.createElement('img')
      img.src = content.url ?? ''
      img.alt = content.caption ?? ''
      el.appendChild(img)
    } else {
      const text = document.createElement('div')
      text.className = 'pt-roamer-win__text'
      text.textContent = content.text ?? ''
      el.appendChild(text)
    }
    if (content.caption !== undefined && content.kind === 'image') {
      const caption = document.createElement('div')
      caption.className = 'pt-roamer-win__caption'
      caption.textContent = content.caption
      el.appendChild(caption)
    }
  }

  /** Clamp a top so the window stays fully on screen whatever the anchor. */
  const clampTop = (top: number, estimatedHeight: number, viewportHeight: number): number =>
    Math.max(8, Math.min(top, viewportHeight - estimatedHeight - 8))

  const spawn = (spec: RoamerWindowSpawn): RoamerWindowHandle => {
    const el = document.createElement('div')
    const isNote = spec.kind === 'note'
    el.className = `pt-roamer-win${isNote ? ' pt-roamer-win--note' : ''}`
    render(el, spec.content)

    let enterClass = 'pt-roamer-enter-pop'
    if (isNote) {
      // Random band placement away from the dead center, slight tilt.
      const vw = spec.viewport.width
      const vh = spec.viewport.height
      el.style.left = `${Math.round(vw * 0.12 + Math.random() * vw * 0.55)}px`
      el.style.top = `${Math.round(vh * 0.12 + Math.random() * vh * 0.6)}px`
      el.style.transform = `rotate(${(Math.random() * 6 - 3).toFixed(1)}deg)`
    } else {
      // Pulled window: rest just inside the edge, at the pet's height.
      const edge = spec.edge ?? 'right'
      el.style.left = edge === 'left' ? '12px' : `${Math.max(12, spec.viewport.width - 312)}px`
      el.style.top = `${clampTop(
        Math.round(spec.anchor.y + spec.anchor.height / 2 - 40),
        160,
        spec.viewport.height,
      )}px`
      enterClass = edge === 'left' ? 'pt-roamer-enter-left' : 'pt-roamer-enter-right'
    }
    el.classList.add(enterClass)
    container.appendChild(el)

    const entry = { el, timer: null as ReturnType<typeof setTimeout> | null }
    entries.push(entry)
    const handle: RoamerWindowHandle = {
      get el() {
        return el
      },
      get closed() {
        return !entries.includes(entry)
      },
      close() {
        if (disposed || !entries.includes(entry)) return
        el.classList.remove(enterClass)
        el.classList.add('pt-roamer-exit')
        entry.timer = setTimeout(() => {
          timers.delete(entry.timer as ReturnType<typeof setTimeout>)
          detach(entry)
        }, EXIT_FADE_MS)
        timers.add(entry.timer)
      },
    }
    later(() => handle.close(), isNote ? NOTE_LINGER_MS : PULL_LINGER_MS)
    return handle
  }

  return {
    spawn,
    closeAll() {
      for (const entry of [...entries]) {
        if (entry.timer !== null) clearTimeout(entry.timer)
        detach(entry)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const entry of [...entries]) detach(entry)
      container.remove()
      style.remove()
    },
  }
}
