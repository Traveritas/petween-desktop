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
  /**
   * Where the bubble lives (user-directed second-batch feedback):
   * - column: the per-session stacks above the pet (stats bubbles; flanking
   *   columns for background sessions)
   * - left: the fixed stack at the pet's LEFT edge (reply previews —
   *   independent of the columns, content clamped)
   * - below: the fixed stack under the pet (turn summaries — independent)
   */
  placement?: 'column' | 'left' | 'below'
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
  /** Border-to-border gap between columns (px, user-adjustable). */
  setColumnGap(px: number): void
  relayout(): void
  closeAll(): void
  dispose(): void
}

export interface BubbleHostOptions {
  anchor(): BubbleAnchor | null
  maxBubbles?: number
  /** Border-to-border gap between columns (px); default 24. */
  columnGapPx?: number
  gapPx?: number
  /** Viewport inset the column must respect (CSS px). */
  marginPx?: number
  viewport?(): { width: number; height: number }
}

interface BubbleEntry {
  key: string
  sessionKey: string
  placement: 'column' | 'left' | 'below'
  el: HTMLElement
  style: BubbleStyle
  /** Removed on close so enter and exit never share the animation property. */
  enterClass: string
  lastTouchedAt: number
  /** False until the first layout — the first position must not transition. */
  placed: boolean
  closing: boolean
  closed: boolean
  removeTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Column slots: focused session → 0; the rest sorted by recency alternate
 * outward (-1, +1, -2, +2 …). Slots only decide ORDER inside the band —
 * actual x positions come from packColumnBand (edge-packed, pet-centered).
 * Pure so the layout is unit-testable.
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

/**
 * Pack all columns edge-to-edge with a fixed border gap and CENTER THE BAND
 * on the pet (user spec, v0.3.3): no pet-width term in the spacing, and if
 * the band overflows the viewport the whole band shifts inward (staying in
 * bounds wins over perfect centering). Returns column center x per key.
 * Pure so the geometry is unit-testable.
 */
export function packColumnBand(
  columns: ReadonlyArray<{ key: string; width: number; slot: number }>,
  petCenterX: number,
  gap: number,
  viewportWidth: number,
  margin: number,
): Map<string, number> {
  const centers = new Map<string, number>()
  if (columns.length === 0) return centers
  const ordered = [...columns].sort((a, b) => a.slot - b.slot)
  const total =
    ordered.reduce((sum, column) => sum + column.width, 0) + gap * (ordered.length - 1)
  const maxX = viewportWidth - margin - total
  const startX =
    maxX < margin
      ? margin // band wider than the viewport: anchor left, stay in bounds
      : Math.min(Math.max(petCenterX - total / 2, margin), maxX)
  let cursor = startX
  for (const column of ordered) {
    centers.set(column.key, cursor + column.width / 2)
    cursor += column.width + gap
  }
  return centers
}

const BASE_CSS = `
.pt-bubbles { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; }
.pt-bubble { position: absolute; transform: translate(-50%, 0); white-space: nowrap; max-width: 340px; }
.pt-bubble--wrap { white-space: normal; }
/* Repositioning glides instead of jumping (new/evicted/relayouted bubbles).
   First placement suppresses the transition inline (see layout). */
.pt-bubble--placed { transition: left 260ms ease, top 260ms ease; }
/* Reply previews: fixed left placement, content clamped to three lines. */
.pt-bubble--at-left { max-width: 300px; white-space: normal; }
.pt-bubble--at-left .pt-bubble__reply {
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
@keyframes pt-bubble-bump {
  0% { transform: translate(-50%, 0) scale(1); }
  40% { transform: translate(-50%, 0) scale(1.12); }
  100% { transform: translate(-50%, 0) scale(1); }
}
.pt-bubble--bump { animation: pt-bubble-bump 220ms ease both; }
`

const BUMP_MS = 240
const TOTAL_CAP_MULTIPLIER = 3
/** Fixed stacks (left/below) carry transient bubbles — tiny independent caps. */
const SIDE_STACK_CAP = 2

export function createBubbleHost(options: BubbleHostOptions): BubbleHost {
  let currentMax = options.maxBubbles ?? 3
  let columnGap = options.columnGapPx ?? 24
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

  /** Apply a position; the very first one lands without the glide transition. */
  const place = (entry: BubbleEntry, left: number, top: number): void => {
    if (!entry.placed) {
      entry.el.style.transition = 'none'
      entry.el.style.left = `${left}px`
      entry.el.style.top = `${top}px`
      void entry.el.offsetWidth // commit the un-transitioned position
      entry.el.style.transition = ''
      entry.el.classList.add('pt-bubble--placed')
      entry.placed = true
      return
    }
    entry.el.style.left = `${left}px`
    entry.el.style.top = `${top}px`
  }

  const clampLeft = (left: number, width: number, view: { width: number }): number => {
    const half = width / 2
    return Math.max(half + margin, Math.min(left, view.width - margin - half))
  }

  /** One column's vertical stack (stats bubbles above the pet). */
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
      place(entry, clampLeft(centerX, entry.el.offsetWidth, view), Math.max(top, margin))
    })
  }

  /** Fixed stack at the pet's LEFT edge, vertically centered, newest nearest. */
  const layoutLeftStack = (stack: BubbleEntry[], anchor: BubbleAnchor, view: { width: number; height: number }): void => {
    const heights = stack.map((entry) => entry.el.offsetHeight)
    const total = heights.reduce((sum, height) => sum + height, 0) + gap * Math.max(0, stack.length - 1)
    let top = Math.max(margin, anchor.y + anchor.height / 2 - total / 2)
    stack.forEach((entry, index) => {
      // Right edge against the pet's left; bubbles are center-anchored, so
      // left = petLeft - gap - halfWidth.
      place(entry, clampLeft(anchor.x - gap - entry.el.offsetWidth / 2, entry.el.offsetWidth, view), top)
      top += heights[index] + gap
    })
  }

  /** Fixed stack UNDER the pet, horizontally centered, newest on top. */
  const layoutBelowStack = (stack: BubbleEntry[], anchor: BubbleAnchor, view: { width: number; height: number }): void => {
    let top = anchor.y + anchor.height + gap
    for (const entry of stack) {
      place(entry, clampLeft(anchor.x + anchor.width / 2, entry.el.offsetWidth, view), Math.min(top, view.height - margin - entry.el.offsetHeight))
      top += entry.el.offsetHeight + gap
    }
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
    const columns = new Map<string, BubbleEntry[]>()
    const leftStack: BubbleEntry[] = []
    const belowStack: BubbleEntry[] = []
    for (const entry of entries) {
      if (entry.placement === 'left') leftStack.push(entry)
      else if (entry.placement === 'below') belowStack.push(entry)
      else {
        const column = columns.get(entry.sessionKey) ?? []
        column.push(entry)
        columns.set(entry.sessionKey, column)
      }
    }
    // Columns: one band, edge-packed with a fixed border gap, the whole band
    // centered on the pet and shifted inward when it would overflow (user
    // spec v0.3.3 — no pet-width term; slots only set the order, focus mid).
    const sessions = [...columns.entries()].map(([key, column]) => ({
      key,
      lastActiveAt: Math.max(...column.map((entry) => entry.lastTouchedAt)),
    }))
    const petCenterX = anchor.x + anchor.width / 2
    const slots = assignColumnSlots(sessions, focusedSession)
    const band = [...columns.entries()].map(([key, column]) => ({
      key,
      slot: slots.get(key) ?? 0,
      width: Math.max(...column.map((entry) => entry.el.offsetWidth)),
    }))
    const centers = packColumnBand(band, petCenterX, columnGap, view.width, margin)
    for (const [key, column] of columns) {
      layoutColumn(column, centers.get(key) ?? petCenterX, anchor, view)
    }
    layoutLeftStack(leftStack, anchor, view)
    layoutBelowStack(belowStack, anchor, view)
  }

  return {
    spawn(spec) {
      const existing = entries.find((entry) => entry.key === spec.key)
      if (existing !== undefined) {
        handleFor(existing).update(spec.content)
        return handleFor(existing)
      }
      const placement = spec.placement ?? 'column'
      const style = getBubbleStyle(spec.styleId)
      const enter = getBubbleEnterAnimation(spec.enterAnimationId)
      const exit = getBubbleExitAnimation(spec.exitAnimationId)
      const el = document.createElement('div')
      const placementClass = placement === 'column' ? '' : ` pt-bubble--at-${placement}`
      el.className = `pt-bubble ${style.className} ${enter.className}${placementClass}`
      el.dataset.ptExitAnimation = exit.id
      style.render(el, spec.content)
      container.appendChild(el)
      const entry: BubbleEntry = {
        key: spec.key,
        sessionKey: spec.sessionKey ?? '',
        placement,
        el,
        style,
        enterClass: enter.className,
        lastTouchedAt: Date.now(),
        placed: false,
        closing: false,
        closed: false,
        removeTimer: null,
      }
      // Newest first within its region.
      const regionOf = (candidate: BubbleEntry): string =>
        candidate.placement === 'column' ? `column:${candidate.sessionKey}` : candidate.placement
      const firstOfRegion = entries.findIndex((candidate) => regionOf(candidate) === regionOf(entry))
      if (firstOfRegion === -1) entries.unshift(entry)
      else entries.splice(firstOfRegion, 0, entry)
      // Evict beyond the region cap: oldest live bubble in THAT region.
      const evictBeyond = (region: string): void => {
        const cap = region.startsWith('column:') ? currentMax : SIDE_STACK_CAP
        const regionEntries = entries.filter((candidate) => regionOf(candidate) === region && !candidate.closing)
        while (regionEntries.length > cap) {
          const victim = regionEntries.pop() as BubbleEntry
          handleFor(victim).close()
        }
        while (entries.filter((candidate) => !candidate.closing).length > currentMax * TOTAL_CAP_MULTIPLIER + SIDE_STACK_CAP * 2) {
          const live = entries.filter((candidate) => !candidate.closing)
          handleFor(live[live.length - 1]).close()
        }
      }
      evictBeyond(regionOf(entry))
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

    setColumnGap(px) {
      columnGap = Math.max(0, px)
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
