/**
 * bubbles/bubble-host.ts — the shared bubble layer (Phase 10). Owns the DOM
 * (a fixed, pointer-events:none container above the pet stage), the spawn →
 * update → close lifecycle with enter/exit animation classes, eviction, and
 * the MULTI-SESSION layout (second batch): bubbles group into per-session
 * columns; the focused session's column stacks right above the pet, the
 * others flank it left/right (alternating, most recent first) so several
 * agents can bubble at once without overlapping. Above the pet with a flip
 * below (and viewport clamping) when there is no room.
 *
 * Deliberately companion-agnostic: the stats HUD and the dialogue bubbles
 * share ONE host (see shared-host.ts) so all columns live in one coordinate
 * system. Coordinates are the overlay page's CSS px — StageSnapshot x/y map
 * 1:1 (trust the snapshot, never vision).
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
  /** Column group — one column per agent session ("" = the legacy shared column). */
  sessionKey?: string
  styleId?: string
  enterAnimationId?: string
  exitAnimationId?: string
  content: BubbleContent
}

export interface BubbleHost {
  spawn(spec: BubbleSpawnSpec): BubbleHandle
  find(key: string): BubbleHandle | null
  /** The session whose column sits directly above the pet (null = first column). */
  setFocusSession(sessionKey: string | null): void
  /** Bubbles per column (total is capped at 3× this). */
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
  sessionKey: string
  el: HTMLElement
  style: BubbleStyle
  /** Removed on close so enter and exit never share the animation property. */
  enterClass: string
  lastTouchedAt: number
  closing: boolean
  closed: boolean
  removeTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Column slots: focused session → 0 (above the pet); the rest sorted by
 * recency → -1, +1, -2, +2 … Pure so the layout is unit-testable.
 */
export function assignColumnSlots(
  sessions: ReadonlyArray<{ key: string; lastActiveAt: number }>,
  focused: string | null,
): Map<string, number> {
  const slots = new Map<string, number>()
  if (sessions.length === 0) return slots
  const ordered = [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  const focus = focused !== null && ordered.some((entry) => entry.key === focused) ? focused : ordered[0].key
  slots.set(focus, 0)
  let nextNegative = -1
  let nextPositive = 1
  for (const entry of ordered) {
    if (entry.key === focus) continue
    // Alternate sides, starting left; prefer whichever side sits closer to
    // the pet so the columns stay bunched (reading order: leftmost is
    // second-newest).
    if (-nextNegative <= nextPositive) {
      slots.set(entry.key, nextNegative)
      nextNegative -= 1
    } else {
      slots.set(entry.key, nextPositive)
      nextPositive += 1
    }
  }
  return slots
}

const BASE_CSS = `
.pt-bubbles { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; }
.pt-bubble { position: absolute; transform: translate(-50%, 0); white-space: nowrap; max-width: 340px; }
.pt-bubble--wrap { white-space: normal; }
@keyframes pt-bubble-bump {
  0% { transform: translate(-50%, 0) scale(1); }
  40% { transform: translate(-50%, 0) scale(1.12); }
  100% { transform: translate(-50%, 0) scale(1); }
}
.pt-bubble--bump { animation: pt-bubble-bump 220ms ease both; }
`

const BUMP_MS = 240
const TOTAL_CAP_MULTIPLIER = 3

export function createBubbleHost(options: BubbleHostOptions): BubbleHost {
  let currentMax = options.maxBubbles ?? 3
  const gap = options.gapPx ?? 6
  const margin = options.marginPx ?? 6
  let focusedSession: string | null = null

  const container = document.createElement('div')
  container.className = 'pt-bubbles'
  const baseStyle = document.createElement('style')
  baseStyle.setAttribute('data-pt-bubble-host', 'base')
  baseStyle.textContent = BASE_CSS
  document.head.appendChild(baseStyle)
  document.body.appendChild(container)

  const entries: BubbleEntry[] = [] // index 0 = newest within its column
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
      entry.lastTouchedAt = Date.now()
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

  /** One column's vertical stack. Returns nothing; positions elements. */
  const layoutColumn = (column: BubbleEntry[], centerX: number, anchor: BubbleAnchor, view: { width: number; height: number }): void => {
    const heights = column.map((entry) => entry.el.offsetHeight)
    const total = heights.reduce((sum, height) => sum + height, 0) + gap * Math.max(0, column.length - 1)
    const roomAbove = anchor.y - margin
    const below = total + gap > roomAbove && anchor.y + anchor.height + gap + total + margin < view.height
    let nextBottom: number
    if (below) {
      nextBottom = anchor.y + anchor.height + gap + total
    } else {
      nextBottom = Math.max(anchor.y - gap, margin + total)
    }
    column.forEach((entry, index) => {
      const height = heights[index]
      const top = nextBottom - height
      nextBottom = top - gap
      entry.el.style.top = `${Math.max(top, margin)}px`
      const half = entry.el.offsetWidth / 2
      const left = Math.min(Math.max(centerX, margin + half), view.width - margin - half)
      entry.el.style.left = `${Math.max(left, half + margin)}px`
    })
  }

  const layout = (): void => {
    if (disposed) return
    const anchor = options.anchor()
    if (anchor === null) {
      container.style.display = 'none'
      return
    }
    container.style.display = ''
    const view = viewport()
    // Group by session, newest-first within each column; a session keeps its
    // column while any of its bubbles (even a fading one) is on stage.
    const bySession = new Map<string, BubbleEntry[]>()
    for (const entry of entries) {
      const column = bySession.get(entry.sessionKey) ?? []
      column.push(entry)
      bySession.set(entry.sessionKey, column)
    }
    const sessions = [...bySession.entries()].map(([key, column]) => ({
      key,
      lastActiveAt: Math.max(...column.map((entry) => entry.lastTouchedAt)),
    }))
    const slots = assignColumnSlots(sessions, focusedSession)
    const stride = Math.max(anchor.width, 160) + 48
    for (const [key, column] of bySession) {
      const slot = slots.get(key) ?? 0
      layoutColumn(column, anchor.x + anchor.width / 2 + slot * stride, anchor, view)
    }
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
      const entry: BubbleEntry = {
        key: spec.key,
        sessionKey: spec.sessionKey ?? '',
        el,
        style,
        enterClass: enter.className,
        lastTouchedAt: Date.now(),
        closing: false,
        closed: false,
        removeTimer: null,
      }
      // Newest first within its column.
      const firstOfColumn = entries.findIndex((candidate) => candidate.sessionKey === entry.sessionKey)
      if (firstOfColumn === -1) entries.unshift(entry)
      else entries.splice(firstOfColumn, 0, entry)
      // Evict beyond the per-column cap: oldest live bubble in THAT column.
      const evictBeyond = (sessionKey: string): void => {
        const column = entries.filter((candidate) => candidate.sessionKey === sessionKey && !candidate.closing)
        while (column.length > currentMax) {
          const victim = column.pop() as BubbleEntry
          handleFor(victim).close()
        }
        while (entries.filter((candidate) => !candidate.closing).length > currentMax * TOTAL_CAP_MULTIPLIER) {
          const live = entries.filter((candidate) => !candidate.closing)
          handleFor(live[live.length - 1]).close()
        }
      }
      evictBeyond(entry.sessionKey)
      layout()
      return handleFor(entry)
    },

    find(key) {
      const entry = entries.find((candidate) => candidate.key === key)
      return entry === undefined || entry.closing ? null : handleFor(entry)
    },

    setFocusSession(sessionKey) {
      if (focusedSession === sessionKey) return
      focusedSession = sessionKey
      layout()
    },

    setMaxBubbles(max) {
      currentMax = max
      for (const key of new Set(entries.map((entry) => entry.sessionKey))) {
        const column = entries.filter((candidate) => candidate.sessionKey === key && !candidate.closing)
        while (column.length > currentMax) {
          const victim = column.pop() as BubbleEntry
          handleFor(victim).close()
        }
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
