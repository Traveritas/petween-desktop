// @vitest-environment jsdom
/**
 * bubble-host DOM lifecycle tests — the v0.4.0 review backlog #1 debt:
 * v0.3.5 / v0.3.6 / v0.3.8 (three production bugs) all lived in this layer
 * and were only ever caught on the real machine. jsdom + stubbed geometry
 * (offsetWidth/offsetHeight are always 0 in jsdom — layout math has its own
 * pure-function tests in bubble-slots.test.ts; here we pin the LIFECYCLE).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBubbleHost, type BubbleHost } from '../../src/renderer/companions/bubbles/bubble-host'

const ANCHOR = { x: 800, y: 700, width: 120, height: 120 }

function makeHost(overrides: Partial<Parameters<typeof createBubbleHost>[0]> = {}): BubbleHost {
  return createBubbleHost({
    anchor: () => ANCHOR,
    viewport: () => ({ width: 2560, height: 1600 }),
    ...overrides,
  })
}

const bubbleEls = (): HTMLElement[] =>
  [...document.body.querySelectorAll('.pt-bubble')] as HTMLElement[]

let host: BubbleHost | null = null

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  host?.dispose()
  host = null
  vi.useRealTimers()
})

describe('spawn dedupe (v0.3.8 regression: exiting entries must not swallow successors)', () => {
  it('same key while LIVE reuses the entry (element count unchanged, content re-rendered)', () => {
    host = makeHost()
    const first = host.spawn({ key: 'edit:s1', sessionKey: 's1', content: { kind: 'edit', sessionId: 's1', added: 3, removed: 1, files: 1 } })
    const second = host.spawn({ key: 'edit:s1', sessionKey: 's1', content: { kind: 'edit', sessionId: 's1', added: 9, removed: 2, files: 4 } })
    expect(second.el).toBe(first.el) // handles are per-call; the ENTRY reuse is what matters
    expect(bubbleEls()).toHaveLength(1)
    expect(bubbleEls()[0].textContent).toContain('9')
  })

  it('same key while CLOSING creates a NEW live bubble — old and new coexist (v0.3.8)', () => {
    host = makeHost()
    const dying = host.spawn({ key: 'turn:s1', sessionKey: 's1', content: { kind: 'turn', sessionId: 's1', thinkingMs: 1000, linesAdded: 1, linesRemoved: 0, edits: 1, durationMs: 2000 } })
    dying.close()
    const successor = host.spawn({ key: 'turn:s1', sessionKey: 's1', content: { kind: 'turn', sessionId: 's1', thinkingMs: 3000, linesAdded: 5, linesRemoved: 2, edits: 3, durationMs: 9000 } })
    expect(successor).not.toBe(dying)
    expect(bubbleEls()).toHaveLength(2) // old fading + new live side by side
    expect(host.find('turn:s1')?.el).toBe(successor.el) // find skips the closing entry
    expect(successor.closed).toBe(false)
  })
})

describe('close lifecycle (v0.3.6 regression: removal must wait for the exit animation length)', () => {
  it('removes the enter class, adds the exit class, removes the element after the EXIT duration (not the default)', () => {
    host = makeHost()
    const handle = host.spawn({
      key: 'reply:s1', sessionKey: 's1', placement: 'left',
      exitAnimationId: 'drift', // 1050ms — well above the 450ms default
      content: { kind: 'reply', sessionId: 's1', text: 'hi' },
    })
    const el = bubbleEls()[0]
    expect(el.className).toContain('pt-bubble-enter-')
    handle.close()
    expect(el.className).not.toContain('pt-bubble-enter-')
    expect(el.className).toContain('pt-bubble-exit-')
    vi.advanceTimersByTime(449)
    expect(bubbleEls()).toHaveLength(1) // default duration NOT enough
    vi.advanceTimersByTime(601)
    expect(bubbleEls()).toHaveLength(0) // gone at ~1050ms
    expect(handle.closed).toBe(true)
  })

  it('close is idempotent; update on a closed entry is a no-op', () => {
    host = makeHost()
    const handle = host.spawn({ key: 'edit:s1', sessionKey: 's1', content: { kind: 'edit', sessionId: 's1', added: 1, removed: 0, files: 1 } })
    handle.close()
    handle.close()
    vi.advanceTimersByTime(600)
    expect(bubbleEls()).toHaveLength(0)
    handle.update({ kind: 'edit', sessionId: 's1', added: 99, removed: 0, files: 1 }, { bump: true })
    expect(bubbleEls()).toHaveLength(0) // no resurrection
  })
})

describe('capacity eviction', () => {
  it('column region evicts its OLDEST live bubble beyond maxBubbles', () => {
    host = makeHost({ maxBubbles: 2 })
    const a = host.spawn({ key: 'a', sessionKey: 's1', content: { kind: 'thinking', sessionId: 's1', startedAt: 1 } })
    const b = host.spawn({ key: 'b', sessionKey: 's1', content: { kind: 'thinking', sessionId: 's1', startedAt: 2 } })
    const c = host.spawn({ key: 'c', sessionKey: 's1', content: { kind: 'thinking', sessionId: 's1', startedAt: 3 } })
    expect(a.closing).toBe(true) // oldest evicted
    expect(b.closing).toBe(false)
    expect(c.closing).toBe(false)
    expect(host.find('a')).toBeNull()
  })

  it('side stacks (left/below) cap at 2 independently of the column cap', () => {
    host = makeHost({ maxBubbles: 3 })
    const replies = [1, 2, 3].map((n) =>
      host.spawn({ key: `r${n}`, sessionKey: 's1', placement: 'left', content: { kind: 'reply', sessionId: 's1', text: `t${n}` } }),
    )
    expect(replies[0].closing).toBe(true) // third reply evicts the oldest
    expect(replies[2].closing).toBe(false)
  })
})

describe('dispose', () => {
  it('clears pending remove timers and removes the whole container — no delayed DOM mutations after', () => {
    host = makeHost()
    const handle = host.spawn({ key: 'x', sessionKey: 's1', exitAnimationId: 'drift', content: { kind: 'edit', sessionId: 's1', added: 1, removed: 0, files: 1 } })
    handle.close()
    host.dispose()
    vi.advanceTimersByTime(5000)
    expect(document.body.querySelectorAll('.pt-bubble').length + document.body.querySelectorAll('.pt-bubble-container').length).toBe(0)
    expect(bubbleEls()).toHaveLength(0)
  })
})

describe('first placement must not transition (v0.3.1 regression family)', () => {
  it('the first layout positions without the glide transition and marks placed', () => {
    host = makeHost()
    host.spawn({ key: 'p', sessionKey: 's1', content: { kind: 'thinking', sessionId: 's1', startedAt: 1 } })
    const el = bubbleEls()[0]
    // The 'none' transition is a synchronous transient inside place(); the
    // observable contract is: placed-class present + coordinates set (and
    // transition cleared back to '' so the NEXT layout can glide).
    expect(el.className).toContain('pt-bubble--placed')
    expect(el.style.transition).toBe('')
    expect(el.style.left).not.toBe('')
    expect(el.style.top).not.toBe('')
  })
})
