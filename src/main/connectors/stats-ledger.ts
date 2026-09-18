/**
 * connectors/stats-ledger.ts — the connector-agnostic stats account book
 * (docs/05 Phase 10). Connectors translate their native events into two
 * normalized facts — state transitions and edit line counts — and this module
 * owns everything downstream: thinking-time accumulation, per-session line
 * totals, a seq-numbered event ring the HUD polls, and the "focused session"
 * pointer (follow target when one exists, else the last active session).
 *
 * Storage is integers and ids ONLY (edit content is reduced to counts at the
 * HTTP boundary — never here, never persisted). Sessions are evicted by the
 * owning connector's watchdog (disposeSession); the ring is bounded so a
 * chatty session cannot grow memory.
 *
 * Pure Node; the clock is injected. v1 consumer: the zcode connector; the
 * DSH bridge can later feed the same ledger from its tool/call arguments.
 */

export type LedgerAgentState = 'idle' | 'thinking' | 'working' | 'waiting' | 'success' | 'error'

export interface EditFact {
  sessionId: string
  /** Epoch ms (the hook payload's zcode timestamp when available). */
  at: number
  turnId?: string
  tool: 'edit' | 'write' | 'patch'
  filePath?: string
  /** Null = payload shape unknown: the event still bubbles, without counts. */
  added: number | null
  removed: number | null
}

export interface StateFact {
  sessionId: string
  state: LedgerAgentState
  at: number
}

export interface StatsLedgerEvent {
  seq: number
  at: number
  sessionId: string
  type: 'state' | 'edit'
  state?: LedgerAgentState
  tool?: EditFact['tool']
  filePath?: string
  added?: number | null
  removed?: number | null
  turnId?: string
}

export interface StatsSessionSummary {
  state: LedgerAgentState
  /** Accumulated thinking time across the session so far (ms). */
  thinkingMs: number
  /** Non-null while the session is in thinking (live timer anchor, epoch ms). */
  thinkingSince: number | null
  linesAdded: number
  linesRemoved: number
  edits: number
  lastAt: number
}

export interface StatsSnapshot {
  /** Monotonic; pass back as ?since= to fetch only newer events. */
  cursor: number
  focusedSessionId: string | null
  sessions: Record<string, StatsSessionSummary>
  /** Ring events with seq > since (the whole ring when since is stale/absent). */
  events: StatsLedgerEvent[]
}

export interface StatsLedger {
  recordState(fact: StateFact): void
  recordEdit(fact: EditFact): void
  /** Explicit focus (follow target); null lets the ledger fall back to the last active session. */
  setFocus(sessionId: string | null): void
  disposeSession(sessionId: string): void
  snapshot(since?: number): StatsSnapshot
}

const RING_CAPACITY = 256

interface SessionRow {
  summary: StatsSessionSummary
}

export interface StatsLedgerDeps {
  now(): number
  log?: (message: string) => void
}

export function createStatsLedger(deps: StatsLedgerDeps): StatsLedger {
  const sessions = new Map<string, SessionRow>()
  const ring: StatsLedgerEvent[] = []
  let seq = 0
  let focus: string | null = null

  const pushEvent = (event: Omit<StatsLedgerEvent, 'seq'>): number => {
    seq += 1
    const full = { ...event, seq } as StatsLedgerEvent
    ring.push(full)
    if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY)
    return seq
  }

  const rowOf = (sessionId: string, at: number): SessionRow => {
    let row = sessions.get(sessionId)
    if (row === undefined) {
      row = { summary: { state: 'idle', thinkingMs: 0, thinkingSince: null, linesAdded: 0, linesRemoved: 0, edits: 0, lastAt: at } }
      sessions.set(sessionId, row)
    }
    return row
  }

  const closeThinking = (row: SessionRow, at: number): void => {
    if (row.summary.thinkingSince === null) return
    row.summary.thinkingMs += Math.max(0, at - row.summary.thinkingSince)
    row.summary.thinkingSince = null
  }

  return {
    recordState({ sessionId, state, at }) {
      const row = rowOf(sessionId, at)
      if (state === 'thinking' && row.summary.state !== 'thinking') {
        row.summary.thinkingSince = at
      } else if (state !== 'thinking') {
        closeThinking(row, at)
      }
      row.summary.state = state
      row.summary.lastAt = at
      pushEvent({ at, sessionId, type: 'state', state })
    },

    recordEdit(fact) {
      const row = rowOf(fact.sessionId, fact.at)
      row.summary.edits += 1
      if (fact.added !== null) row.summary.linesAdded += fact.added
      if (fact.removed !== null) row.summary.linesRemoved += fact.removed
      row.summary.lastAt = fact.at
      pushEvent({
        at: fact.at,
        sessionId: fact.sessionId,
        type: 'edit',
        tool: fact.tool,
        filePath: fact.filePath,
        added: fact.added,
        removed: fact.removed,
        turnId: fact.turnId,
      })
    },

    setFocus(sessionId) {
      focus = sessionId
    },

    disposeSession(sessionId) {
      sessions.delete(sessionId)
      if (focus === sessionId) focus = null
    },

    snapshot(since = 0) {
      const summaries: Record<string, StatsSessionSummary> = {}
      for (const [id, row] of sessions) summaries[id] = { ...row.summary }
      const events = since > 0 ? ring.filter((event) => event.seq > since) : [...ring]
      return {
        cursor: seq,
        focusedSessionId: focus ?? lastActiveSession(sessions),
        sessions: summaries,
        events,
      }
    },
  }
}

/** Fallback focus: the session whose last fact is newest (no explicit target). */
function lastActiveSession(sessions: Map<string, SessionRow>): string | null {
  let best: string | null = null
  let bestAt = -Infinity
  for (const [id, row] of sessions) {
    if (row.summary.lastAt >= bestAt) {
      best = id
      bestAt = row.summary.lastAt
    }
  }
  return best
}
