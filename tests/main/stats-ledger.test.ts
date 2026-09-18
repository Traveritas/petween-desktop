/**
 * stats-ledger: per-session thinking accumulation, edit totals, the seq ring
 * the HUD polls, and focused-session resolution (explicit focus > last
 * active). Clock injected; no timers involved.
 */
import { describe, expect, it } from 'vitest'
import { createStatsLedger } from '../../src/main/connectors/stats-ledger'

const T0 = 1_000_000

function ledger() {
  let now = T0
  const api = createStatsLedger({ now: () => now })
  return {
    ...api,
    advance(ms: number): void {
      now += ms
    },
    now: () => now,
  }
}

describe('thinking accumulation', () => {
  it('sums thinking intervals across a turn and exposes the live anchor', () => {
    const book = ledger()
    book.recordState({ sessionId: 's1', state: 'thinking', at: T0 })
    book.recordState({ sessionId: 's1', state: 'working', at: T0 + 3000 })
    book.recordState({ sessionId: 's1', state: 'thinking', at: T0 + 5000 })
    const mid = book.snapshot()
    expect(mid.sessions.s1.thinkingMs).toBe(3000)
    expect(mid.sessions.s1.thinkingSince).toBe(T0 + 5000)
    book.recordState({ sessionId: 's1', state: 'success', at: T0 + 7500 })
    const done = book.snapshot()
    expect(done.sessions.s1.thinkingMs).toBe(5500)
    expect(done.sessions.s1.thinkingSince).toBeNull()
  })

  it('waiting interrupts thinking (permission pauses the clock)', () => {
    const book = ledger()
    book.recordState({ sessionId: 's1', state: 'thinking', at: T0 })
    book.recordState({ sessionId: 's1', state: 'waiting', at: T0 + 2000 })
    book.recordState({ sessionId: 's1', state: 'working', at: T0 + 9000 })
    expect(book.snapshot().sessions.s1.thinkingMs).toBe(2000)
  })
})

describe('edit facts', () => {
  it('accumulates counts and edit count per session', () => {
    const book = ledger()
    book.recordEdit({ sessionId: 's1', at: T0, tool: 'edit', added: 5, removed: 2, filePath: 'a.ts' })
    book.recordEdit({ sessionId: 's1', at: T0 + 100, tool: 'write', added: 30, removed: null })
    book.recordEdit({ sessionId: 's2', at: T0 + 200, tool: 'edit', added: null, removed: null })
    const snap = book.snapshot()
    expect(snap.sessions.s1).toMatchObject({ linesAdded: 35, linesRemoved: 2, edits: 2 })
    expect(snap.sessions.s2).toMatchObject({ linesAdded: 0, linesRemoved: 0, edits: 1 })
  })

  it('ring events carry the fact fields; unknown counts stay null', () => {
    const book = ledger()
    book.recordEdit({ sessionId: 's1', at: T0, tool: 'patch', added: null, removed: null, turnId: 'turn_1' })
    const [event] = book.snapshot().events
    expect(event).toMatchObject({ type: 'edit', tool: 'patch', added: null, removed: null, turnId: 'turn_1' })
  })
})

describe('cursor / incremental fetch', () => {
  it('returns only newer events via since; cursor is monotonic', () => {
    const book = ledger()
    book.recordState({ sessionId: 's1', state: 'thinking', at: T0 })
    const first = book.snapshot()
    book.recordEdit({ sessionId: 's1', at: T0 + 10, tool: 'edit', added: 1, removed: 0 })
    const second = book.snapshot(first.cursor)
    expect(second.events).toHaveLength(1)
    expect(second.events[0].type).toBe('edit')
    expect(second.cursor).toBe(first.cursor + 1)
  })
})

describe('focused session', () => {
  it('falls back to the most recently active session without explicit focus', () => {
    const book = ledger()
    book.recordState({ sessionId: 's1', state: 'thinking', at: T0 })
    book.recordState({ sessionId: 's2', state: 'working', at: T0 + 500 })
    expect(book.snapshot().focusedSessionId).toBe('s2')
  })

  it('explicit focus wins until cleared', () => {
    const book = ledger()
    book.recordState({ sessionId: 's1', state: 'thinking', at: T0 })
    book.recordState({ sessionId: 's2', state: 'working', at: T0 + 500 })
    book.setFocus('s1')
    expect(book.snapshot().focusedSessionId).toBe('s1')
    book.setFocus(null)
    expect(book.snapshot().focusedSessionId).toBe('s2')
  })
})

describe('disposeSession', () => {
  it('drops the row and clears focus pointing at it', () => {
    const book = ledger()
    book.recordState({ sessionId: 's1', state: 'thinking', at: T0 })
    book.setFocus('s1')
    book.disposeSession('s1')
    const snap = book.snapshot()
    expect(snap.sessions.s1).toBeUndefined()
    expect(snap.focusedSessionId).toBeNull()
    // Ring history survives (the HUD may still be fading its bubble).
    expect(snap.events.length).toBeGreaterThan(0)
  })
})
