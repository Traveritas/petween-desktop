/**
 * bubbles/bubble-host.ts — the shared bubble layer (Phase 10). Owns the DOM
 * (a fixed, pointer-events:none container above the pet stage), the spawn →
 * update → close lifecycle with enter/exit animation classes, eviction, and
 * the stacking layout: a column above the pet, newest bubble nearest the pet,
 * flipping below (and clamping to the viewport) when there is no room.
 *
 * Deliberately companion-agnostic: the stats HUD is the first consumer, the
 * dialogue-bubble plugin is the intended second (same registry, same host).
 * Coordinates are the overlay page's CSS px — StageSnapshot x/y/scale map 1:1
 * (trust the snapshot, never vision).
 */
import { getBubbleStyle, type BubbleContent, type BubbleStyle } from './styles'
import {
  BUBBLE_EXIT_MS,
  getBubbleEnterAnimation,
  getBubbleExitAnimation,
} from './animations'

export interface BubbleAnchor {
  /** Viewport CSS px; the pet's bounding box (stageSize × scale at x/y). */
  x: number
  y: number
  width: number
  height: number
}

export interface BubbleHandle {
  readonly key: string
  readonly el: HTMLElement
  readonly closing: boolean
  readonly closed: boolean
  /** Re-render content (live counts / timer refresh). bump pulses the value. */
  update(content: BubbleContent, options?: { bump?: boolean }): void
  /** Start the exit animation; the element is removed afterwards. Idempotent. */
  close(): void
}

export interface BubbleSpawnSpec {
  key: string
  styleId?: string
  enterAnimationId?: string
  exitAnimationId?: string
  content: BubbleContent
}

export interface BubbleHost {
  spawn(spec: BubbleSpawnSpec): BubbleHandle
  find(key: string): BubbleHandle | null
  setMaxBubbles(max: number): void
  relayout(): void
  closeAll(): void
  dispose(): void
}

export interface BubbleHostOptions {
  anchor(): BubbleAnchor | null
  maxBubbles?: number
  gapPx?: number
  /** Viewport inset the column must respect (CSS px). */
  marginPx?: number
  viewport?(): { width: number; height: number }
}

interface BubbleEntry {
  key: string
  el: HTMLElement
  style: BubbleStyle
  /** Removed on close so enter and exit never share the animation property. */
  enterClass: string
  closing: boolean
  closed: boolean
  removeTimer: ReturnType<typeof setTimeout> | null
}

const BASE_CSS = `
.pt-bubbles { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; }
.pt-bubble { position: absolute; transform: translate(-50%, 0); white-space: nowrap; }
@keyframes pt-bubble-bump {
  0% { transform: translate(-50%, 0) scale(1); }
  40% { transform: translate(-50%, 0) scale(1.12); }
  100% { transform: translate(-50%, 0) scale(1); }
}
.pt-bubble--bump { animation: pt-bubble-bump 220ms ease both; }
`

const BUMP_MS = 240

export function createBubbleHost(options: BubbleHostOptions): BubbleHost {
  let currentMax = options.maxBubbles ?? 4
  const gap = options.gapPx ?? 6
  const margin = options.marginPx ?? 6

  const container = document.createElement('div')
  container.className = 'pt-bubbles'
  const baseStyle = document.createElement('style')
  baseStyle.setAttribute('data-pt-bubble-host', 'base')
  baseStyle.textContent = BASE_CSS
  document.head.appendChild(baseStyle)
  document.body.appendChild(container)

  const entries: BubbleEntry[] = [] // index 0 = newest
  let disposed = false

  const viewport = (): { width: number; height: number } =>
    options.viewport?.() ?? { width: window.innerWidth, height: window.innerHeight }

  const removeEntry = (entry: BubbleEntry): void => {
    const index = entries.indexOf(entry)
    if (index >= 0) entries.splice(index, 1)
    entry.el.remove()
    layout()
  }

  const handleFor = (entry: BubbleEntry): BubbleHandle => ({
    get key() {
      return entry.key
    },
    get el() {
      return entry.el
    },
    get closing() {
      return entry.closing
    },
    get closed() {
      return entry.closed
    },
    update(content, updateOptions) {
      if (entry.closed || disposed) return
      entry.style.render(entry.el, content)
      if (updateOptions?.bump === true && !entry.closing) {
        entry.el.classList.remove('pt-bubble--bump')
        void entry.el.offsetWidth // restart the animation
        entry.el.classList.add('pt-bubble--bump')
        setTimeout(() => entry.el.classList.remove('pt-bubble--bump'), BUMP_MS)
      }
      layout()
    },
    close() {
      if (entry.closing || entry.closed || disposed) return
      entry.closing = true
      const exit = getBubbleExitAnimation(entry.el.dataset.ptExitAnimation)
      entry.el.classList.remove('pt-bubble--bump', entry.enterClass)
      entry.el.classList.add(exit.className)
      entry.removeTimer = setTimeout(() => {
        entry.closed = true
        removeEntry(entry)
      }, exit.durationMs ?? BUBBLE_EXIT_MS)
      layout()
    },
  })

  /** Stack the column: above the pet (newest nearest), flip below when cramped. */
  const layout = (): void => {
    if (disposed) return
    const anchor = options.anchor()
    if (anchor === null) {
      container.style.display = 'none'
      return
    }
    container.style.display = ''
    const view = viewport()
    const centerX = anchor.x + anchor.width / 2
    const heights = entries.map((entry) => entry.el.offsetHeight)
    const total = heights.reduce((sum, height) => sum + height, 0) + gap * Math.max(0, entries.length - 1)
    const roomAbove = anchor.y - margin
    const below = total + gap > roomAbove && anchor.y + anchor.height + gap + total + margin < view.height
    let nextBottom: number
    if (below) {
      nextBottom = anchor.y + anchor.height + gap + total
    } else {
      nextBottom = Math.max(anchor.y - gap, margin + total)
    }
    entries.forEach((entry, index) => {
      const height = heights[index]
      const top = nextBottom - height
      nextBottom = top - gap
      entry.el.style.top = `${Math.max(top, margin)}px`
      const half = entry.el.offsetWidth / 2
      const left = Math.min(Math.max(centerX, margin + half), view.width - margin - half)
      entry.el.style.left = `${Math.max(left, half + margin)}px`
    })
  }

  return {
    spawn(spec) {
      const existing = entries.find((entry) => entry.key === spec.key)
      if (existing !== undefined) {
        handleFor(existing).update(spec.content)
        return handleFor(existing)
      }
      const style = getBubbleStyle(spec.styleId)
      const enter = getBubbleEnterAnimation(spec.enterAnimationId)
      const exit = getBubbleExitAnimation(spec.exitAnimationId)
      const el = document.createElement('div')
      el.className = `pt-bubble ${style.className} ${enter.className}`
      el.dataset.ptExitAnimation = exit.id
      style.render(el, spec.content)
      container.appendChild(el)
      const entry: BubbleEntry = { key: spec.key, el, style, enterClass: enter.className, closing: false, closed: false, removeTimer: null }
      entries.unshift(entry)
      // Evict beyond capacity: oldest live bubble (end of the list), never
      // one already exiting — those are about to free their slot.
      let live = entries.filter((candidate) => !candidate.closing)
      while (live.length > currentMax) {
        const victim = live[live.length - 1]
        handleFor(victim).close()
        live = live.filter((candidate) => candidate !== victim)
      }
      layout()
      return handleFor(entry)
    },

    find(key) {
      const entry = entries.find((candidate) => candidate.key === key)
      return entry === undefined || entry.closing ? null : handleFor(entry)
    },

    setMaxBubbles(max) {
      currentMax = max
      const live = entries.filter((candidate) => !candidate.closing)
      while (live.length > currentMax) {
        const victim = live[live.length - 1]
        handleFor(victim).close()
        live.splice(live.indexOf(victim), 1)
      }
    },

    relayout: layout,

    closeAll() {
      for (const entry of [...entries]) handleFor(entry).close()
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const entry of entries) {
        if (entry.removeTimer !== null) clearTimeout(entry.removeTimer)
        entry.closed = true
      }
      entries.length = 0
      container.remove()
      baseStyle.remove()
    },
  }
}
