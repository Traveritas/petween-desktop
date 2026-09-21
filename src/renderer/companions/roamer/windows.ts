/**
 * roamer/windows.ts — the mischief content layer (docs/05 Phase 17 batch 3,
 * feedback pass 2026-09-21): the pulled-out content windows and sticky notes
 * the pet drags onto the desktop. BubbleHost's skeleton applied to a
 * different shape — a fixed, pointer-events:none layer (click-through
 * untouched), spawn → linger → exit-class → timer removal, viewport
 * clamping, and a dispose that clears every timer. Below the bubble layer
 * so stats/dialogue bubbles always win.
 *
 * Two placements:
 *  - pull: a mini "window" (title bar with traffic dots + caption) anchored
 *    near the pet, sliding in FROM the screen edge the pet walked to;
 *  - note: a sticky note (tape strip, lined paper for text, polaroid frame
 *    for images) at a random band position with a slight tilt.
 *
 * Linger is caller-supplied (options.mischief pull/noteLingerMs, 0.5..60s).
 *
 * Two DOM/CSS traps this file is explicit about:
 *  - The note tilt is a CSS custom property (--pt-rot) consumed INSIDE the
 *    pop keyframes, not an inline transform: keyframes with fill-mode both
 *    permanently override inline transforms after the enter animation.
 *  - Images size to their container (width:100%), never to the generic
 *    300px cap — a 210px note used to clip wide images mid-picture.
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
  /** Linger before the fade; defaults below when omitted. */
  lingerMs?: number
}

export interface RoamerWindowHandle {
  readonly el: HTMLElement
  readonly closed: boolean
  /** Start the exit fade; the element is removed afterwards. Idempotent. */
  close(): void
}

export interface RoamerWindowHost {
  spawn(spec: RoamerWindowSpawn): RoamerWindowHandle
  dispose(): void
}

/** Fallback linger (callers pass the user's option through). */
const PULL_LINGER_MS = 25000
const NOTE_LINGER_MS = 45000
const EXIT_FADE_MS = 600

const BASE_CSS = `
.pt-roamer-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147280000; }

/* --- pulled window: a hand-dragged mini window --- */
.pt-roamer-win {
  position: absolute; max-width: 300px; border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.14);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.42), 0 2px 6px rgba(0, 0, 0, 0.18);
  font: 13px/1.5 system-ui, 'Segoe UI', sans-serif; color: #222;
  background: linear-gradient(180deg, #ffffff, #f3f1ea);
  overflow: hidden;
}
.pt-roamer-win__bar {
  display: flex; align-items: center; gap: 6px; padding: 7px 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08); font-size: 11px; color: #555;
}
.pt-roamer-win__dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
.pt-roamer-win__dot:nth-of-type(1) { background: #ff5f57; }
.pt-roamer-win__dot:nth-of-type(2) { background: #febc2e; }
.pt-roamer-win__dot:nth-of-type(3) { background: #28c840; }
.pt-roamer-win__bar .pt-roamer-win__caption {
  flex: 1 1 auto; padding: 0; border: 0; font-size: 11px; color: #555;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pt-roamer-win img {
  display: block; width: 100%; height: auto; max-height: 42vh;
  object-fit: contain; background: #fff;
}
.pt-roamer-win__text { padding: 10px 12px; white-space: pre-wrap; word-break: break-word; max-height: 30vh; overflow: hidden; }

/* --- sticky note: tape strip + lined paper (text) or polaroid (image) --- */
.pt-roamer-win--note {
  max-width: 210px; border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 3px; box-shadow: 0 5px 16px rgba(0, 0, 0, 0.3);
  background: repeating-linear-gradient(
    180deg, #fff8c4 0px, #fff8c4 25px, #f3ecab 26px
  );
}
.pt-roamer-win--note::before {
  content: ''; position: absolute; top: -9px; left: 50%;
  transform: translateX(-50%) rotate(-2deg);
  width: 62px; height: 17px; border-radius: 1px;
  background: rgba(228, 226, 204, 0.9); border: 1px solid rgba(0, 0, 0, 0.07);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}
.pt-roamer-win--note .pt-roamer-win__text {
  font-family: KaiTi, 'Kaiti SC', cursive; font-size: 14px; max-height: 18vh;
  background: transparent; padding: 12px 12px 10px;
}
/* Image notes switch to a white polaroid frame (lines would fight the photo). */
.pt-roamer-win--note.pt-roamer-win--has-image {
  background: #fff; padding: 8px 8px 6px;
}
.pt-roamer-win--note.pt-roamer-win--has-image img {
  border-radius: 2px; background: #f4f2ec;
}
.pt-roamer-win--note .pt-roamer-win__caption {
  padding: 4px 2px 2px; font-size: 12px; color: #6b6350;
  font-family: KaiTi, 'Kaiti SC', cursive;
  border-top: 0;
}

@keyframes pt-roamer-slide-left {
  from { transform: translateX(calc(-100% - 32px)); }
  to { transform: translateX(0); }
}
@keyframes pt-roamer-slide-right {
  from { transform: translateX(calc(100% + 32px)); }
  to { transform: translateX(0); }
}
/* The tilt rides a custom property: fill-mode both would otherwise pin the
   transform to the keyframe end value and silently kill the inline rotate. */
@keyframes pt-roamer-pop {
  from { transform: scale(0.6) rotate(var(--pt-rot, 0deg)); opacity: 0; }
  to { transform: scale(1) rotate(var(--pt-rot, 0deg)); opacity: 1; }
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

  const dots = (): DocumentFragment => {
    const fragment = document.createDocumentFragment()
    for (let i = 0; i < 3; i += 1) {
      const dot = document.createElement('span')
      dot.className = 'pt-roamer-win__dot'
      fragment.appendChild(dot)
    }
    return fragment
  }

  const render = (el: HTMLElement, content: RoamerContentItem, isNote: boolean): void => {
    if (content.kind === 'image') {
      el.classList.add('pt-roamer-win--has-image')
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
    if (content.caption !== undefined) {
      const caption = document.createElement('div')
      caption.className = 'pt-roamer-win__caption'
      caption.textContent = content.caption
      if (isNote) el.appendChild(caption)
      else {
        // Pulled windows show the caption in a title bar with traffic dots.
        const bar = document.createElement('div')
        bar.className = 'pt-roamer-win__bar'
        bar.appendChild(dots())
        bar.appendChild(caption)
        el.prepend(bar)
      }
    } else if (!isNote) {
      const bar = document.createElement('div')
      bar.className = 'pt-roamer-win__bar'
      bar.appendChild(dots())
      el.prepend(bar)
    }
  }

  /**
   * Clamp a top so the window stays fully on screen whatever the anchor.
   * The budget mirrors the CSS caps above (img ≤ 42vh + bar ≈ 32px) —
   * the old flat 160px estimate let tall images hang off the bottom when
   * the pet anchored low.
   */
  const clampTop = (top: number, viewportHeight: number): number => {
    const budget = Math.ceil(viewportHeight * 0.42) + 40
    return Math.max(8, Math.min(top, viewportHeight - budget - 8))
  }

  const spawn = (spec: RoamerWindowSpawn): RoamerWindowHandle => {
    const el = document.createElement('div')
    const isNote = spec.kind === 'note'
    el.className = `pt-roamer-win${isNote ? ' pt-roamer-win--note' : ''}`
    render(el, spec.content, isNote)

    let enterClass = 'pt-roamer-enter-pop'
    if (isNote) {
      // Random band placement away from the dead center, slight tilt (the
      // tilt rides --pt-rot — see the keyframes comment above).
      const vw = spec.viewport.width
      const vh = spec.viewport.height
      el.style.left = `${Math.round(vw * 0.12 + Math.random() * vw * 0.55)}px`
      el.style.top = `${Math.round(vh * 0.12 + Math.random() * vh * 0.6)}px`
      el.style.setProperty('--pt-rot', `${(Math.random() * 6 - 3).toFixed(1)}deg`)
    } else {
      // Pulled window: rest just inside the edge, at the pet's height.
      const edge = spec.edge ?? 'right'
      el.style.left = edge === 'left' ? '12px' : `${Math.max(12, spec.viewport.width - 312)}px`
      el.style.top = `${clampTop(Math.round(spec.anchor.y + spec.anchor.height / 2 - 40), spec.viewport.height)}px`
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
    const fallbackLinger = isNote ? NOTE_LINGER_MS : PULL_LINGER_MS
    later(() => handle.close(), Math.max(500, spec.lingerMs ?? fallbackLinger))
    return handle
  }

  return {
    spawn,
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
