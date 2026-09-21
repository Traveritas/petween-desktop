// @vitest-environment jsdom
/**
 * roamer windows: the mischief content layer (docs/05 Phase 17 batch 3).
 * Class/timer driven like the bubble layer — jsdom runs no CSS animations,
 * so tests assert placement styles, enter/exit classes and removal timing
 * under fake timers. Layout math is inline here (two fixed placements, no
 * cross-entry relayout to extract).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoamerWindowHost } from '../../src/renderer/companions/roamer/windows'
import type { RoamerContentItem, RoamerWindowHost } from '../../src/renderer/companions/roamer/windows'

const IMAGE: RoamerContentItem = { id: 'p1', kind: 'image', url: '/petween-assets/a', caption: '注' }
const TEXT: RoamerContentItem = { id: 'p2', kind: 'text', text: '便签内容' }

const VIEWPORT = { width: 1920, height: 1080 }
const ANCHOR = { x: 1750, y: 540, height: 128 }

let host: RoamerWindowHost

beforeEach(() => {
  vi.useFakeTimers()
  host = createRoamerWindowHost()
})
afterEach(() => {
  host.dispose()
  vi.useRealTimers()
})

const layerEl = (): HTMLElement => document.querySelector('.pt-roamer-layer') as HTMLElement

describe('pulled windows', () => {
  it('renders an image card with a title bar (dots + caption) anchored inside the edge', () => {
    const handle = host.spawn({ kind: 'pull', edge: 'right', content: IMAGE, anchor: ANCHOR, viewport: VIEWPORT })
    expect(layerEl().contains(handle.el)).toBe(true)
    expect(handle.el.className).toContain('pt-roamer-win')
    expect(handle.el.className).toContain('pt-roamer-enter-right')
    // right edge: just inside 1920 - 312
    expect(handle.el.style.left).toBe('1608px')
    // title bar: three traffic dots + the caption
    const bar = handle.el.querySelector('.pt-roamer-win__bar')
    expect(bar).not.toBeNull()
    expect(bar?.querySelectorAll('.pt-roamer-win__dot')).toHaveLength(3)
    expect(bar?.querySelector('.pt-roamer-win__caption')?.textContent).toBe('注')
    // top anchored at the pet's mid-height, clamped
    expect(Number.parseInt(handle.el.style.top, 10)).toBeGreaterThan(0)
    expect(handle.el.querySelector('img')?.getAttribute('src')).toBe('/petween-assets/a')
  })

  it('left edge mirrors the placement and enter class', () => {
    const handle = host.spawn({ kind: 'pull', edge: 'left', content: TEXT, anchor: ANCHOR, viewport: VIEWPORT })
    expect(handle.el.style.left).toBe('12px')
    expect(handle.el.className).toContain('pt-roamer-enter-left')
    expect(handle.el.querySelector('.pt-roamer-win__text')?.textContent).toBe('便签内容')
  })

  it('lingers, fades and is removed (timer chain), honoring a caller linger', () => {
    const handle = host.spawn({ kind: 'pull', edge: 'right', content: IMAGE, anchor: ANCHOR, viewport: VIEWPORT })
    vi.advanceTimersByTime(25000 - 1)
    expect(handle.el.className).not.toContain('pt-roamer-exit')
    vi.advanceTimersByTime(1)
    expect(handle.el.className).toContain('pt-roamer-exit')
    expect(handle.closed).toBe(false)
    vi.advanceTimersByTime(600)
    expect(handle.closed).toBe(true)
    expect(layerEl().contains(handle.el)).toBe(false)

    // a custom linger overrides the default (settings: 0.5s..60s)
    const quick = host.spawn({ kind: 'pull', edge: 'right', content: IMAGE, anchor: ANCHOR, viewport: VIEWPORT, lingerMs: 5000 })
    vi.advanceTimersByTime(4999)
    expect(quick.el.className).not.toContain('pt-roamer-exit')
    vi.advanceTimersByTime(1)
    expect(quick.el.className).toContain('pt-roamer-exit')
  })
})

describe('sticky notes', () => {
  it('renders the note skin at a tilted random spot', () => {
    const handle = host.spawn({ kind: 'note', content: TEXT, anchor: ANCHOR, viewport: VIEWPORT })
    expect(handle.el.className).toContain('pt-roamer-win--note')
    expect(handle.el.className).toContain('pt-roamer-enter-pop')
    // The tilt rides --pt-rot (an inline transform would be pinned by the
    // pop keyframes' fill-mode both after the enter animation).
    expect(handle.el.style.getPropertyValue('--pt-rot')).toMatch(/^-?\d+(\.\d+)?deg$/)
    const left = Number.parseInt(handle.el.style.left, 10)
    const top = Number.parseInt(handle.el.style.top, 10)
    expect(left).toBeGreaterThanOrEqual(1920 * 0.12 - 1)
    expect(left).toBeLessThanOrEqual(1920 * 0.67 + 1)
    expect(top).toBeGreaterThan(0)
    expect(top).toBeLessThan(1080)
  })

  it('switches to the polaroid frame for image notes (no more mid-picture clipping)', () => {
    const handle = host.spawn({ kind: 'note', content: IMAGE, anchor: ANCHOR, viewport: VIEWPORT })
    expect(handle.el.className).toContain('pt-roamer-win--has-image')
    expect(handle.el.querySelector('img')).not.toBeNull()
  })

  it('sticks around longer than a pulled window', () => {
    const note = host.spawn({ kind: 'note', content: TEXT, anchor: ANCHOR, viewport: VIEWPORT })
    const pull = host.spawn({ kind: 'pull', edge: 'right', content: IMAGE, anchor: ANCHOR, viewport: VIEWPORT })
    vi.advanceTimersByTime(25000 + 600)
    expect(note.closed).toBe(false)
    expect(pull.closed).toBe(true)
  })
})

describe('host lifecycle', () => {
  it('close() is idempotent and dispose clears everything', () => {
    const handle = host.spawn({ kind: 'pull', edge: 'right', content: IMAGE, anchor: ANCHOR, viewport: VIEWPORT })
    handle.close()
    handle.close()
    expect(handle.el.className).toContain('pt-roamer-exit')
    vi.advanceTimersByTime(600)
    expect(handle.closed).toBe(true)

    host.spawn({ kind: 'note', content: TEXT, anchor: ANCHOR, viewport: VIEWPORT })
    host.dispose()
    expect(document.querySelector('.pt-roamer-layer')).toBeNull()
    // lingering timers were cleared: nothing throws afterwards
    vi.advanceTimersByTime(200000)
  })
})
