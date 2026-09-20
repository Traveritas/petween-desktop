/**
 * codex connector: the third profile on the shared hook-connector engine.
 * Engine-level behaviour is the zcode/CC test suites' contract; these tests
 * pin the Codex deltas: session-end disposal, watchdogs, follow gating, and
 * stats with the turn_id payload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodexConnector } from '../../src/main/connectors/codex-connector'
import type { StateRelay } from '../../src/main/state-relay'

interface Emission {
  method: 'event' | 'disposed' | 'status' | 'error'
  sessionId: string
  event?: { type: string; data: unknown }
  status?: string
}

function fakeRelay(): { relay: StateRelay; emissions: Emission[] } {
  const emissions: Emission[] = []
  const relay = {
    emitSessionEvent(sessionId: string, event: { type: string; data: unknown }) {
      emissions.push({ method: 'event', sessionId, event })
    },
    emitSessionDisposed(sessionId: string) {
      emissions.push({ method: 'disposed', sessionId })
    },
    emitAgentStatus(sessionId: string, status: string) {
      emissions.push({ method: 'status', sessionId, status })
    },
    emitAgentError(sessionId: string) {
      emissions.push({ method: 'error', sessionId })
    },
  } as unknown as StateRelay
  return { relay, emissions }
}

const SESSION = 'codex_11111111-2222-3333-4444-555555555555'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function setup(options?: { follow?: boolean }) {
  const { relay, emissions } = fakeRelay()
  return {
    emissions,
    connector: createCodexConnector({
      relay,
      now: () => 1_000,
      isFollowEnabled: () => options?.follow ?? false,
    }),
  }
}

describe('event mapping', () => {
  it('the full vocabulary maps onto the DSH envelopes', () => {
    const { emissions, connector } = setup()
    connector.handle({ kind: 'session-start', sessionId: SESSION })
    connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    connector.handle({ kind: 'pre-tool-edit', sessionId: SESSION })
    connector.handle({ kind: 'pre-tool-command', sessionId: SESSION })
    connector.handle({ kind: 'pre-tool-other', sessionId: SESSION })
    connector.handle({ kind: 'post-tool', sessionId: SESSION })
    connector.handle({ kind: 'permission-request', sessionId: SESSION })
    connector.handle({ kind: 'stop', sessionId: SESSION })
    expect(emissions.map((e) => e.method === 'status' ? `status:${e.status}` : e.event?.type)).toEqual([
      'status:idle',
      'turn/start',
      'assistant/chunk',
      'tool/call',
      'tool/call',
      'tool/call',
      'tool/result',
      'approval/asked',
      'turn/end',
    ])
  })

  it('session-end disposes the session immediately, timers dying with it', () => {
    const { emissions, connector } = setup()
    connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    emissions.length = 0
    connector.handle({ kind: 'session-end', sessionId: SESSION })
    expect(emissions).toEqual([{ method: 'disposed', sessionId: SESSION }])
    vi.advanceTimersByTime(3_600_000)
    expect(emissions).toEqual([{ method: 'disposed', sessionId: SESSION }])
  })

  it('watchdogs: stop decays in 60s, permission in 10min, crash dispose at 30min', () => {
    const { emissions, connector } = setup()
    connector.handle({ kind: 'stop', sessionId: SESSION })
    vi.advanceTimersByTime(60_000)
    expect(emissions.some((e) => e.method === 'status' && e.status === 'idle')).toBe(true)

    const second = setup()
    second.connector.handle({ kind: 'permission-request', sessionId: SESSION })
    vi.advanceTimersByTime(600_000)
    expect(second.emissions.some((e) => e.method === 'status' && e.status === 'idle')).toBe(true)

    const third = setup()
    third.connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    vi.advanceTimersByTime(1_800_000)
    expect(third.emissions.some((e) => e.method === 'disposed')).toBe(true)
  })

  it('follow mode gates background sessions; switching applies the current event', () => {
    const OTHER = 'codex_99999999-8888-7777-6666-555555555555'
    const { emissions, connector } = setup({ follow: true })
    connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    connector.handle({ kind: 'pre-tool-edit', sessionId: SESSION })
    emissions.length = 0

    connector.handle({ kind: 'pre-tool-command', sessionId: OTHER })
    expect(emissions.some((e) => e.sessionId === OTHER)).toBe(false)

    connector.handle({ kind: 'user-prompt-submit', sessionId: OTHER })
    const otherEvents = emissions.filter((e) => e.sessionId === OTHER)
    expect(otherEvents.map((e) => e.event?.type)).toEqual(['tool/call', 'turn/start', 'assistant/chunk'])
  })

  it('stats: turn_id is the turnId; session-end drops the ledger row', () => {
    const calls: Array<Record<string, unknown>> = []
    const ledger = {
      recordState: (state: Record<string, unknown>) => calls.push({ kind: 'state', state }),
      recordEdit: (edit: Record<string, unknown>) => calls.push({ kind: 'edit', edit }),
      recordTurnStart: (turn: Record<string, unknown>) => calls.push({ kind: 'turn-start', turn }),
      setFocus: (sessionId: string) => calls.push({ kind: 'focus', sessionId }),
      disposeSession: (sessionId: string) => calls.push({ kind: 'dispose', sessionId }),
      snapshot: () => ({ cursor: 0, focusedSessionId: null, sessions: {}, events: [] }),
    }
    const { relay } = fakeRelay()
    const connector = createCodexConnector({ relay, now: () => 100, stats: ledger as never })
    connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION, payload: { turnId: 'turn_01' } })
    connector.handle({ kind: 'stop', sessionId: SESSION, payload: { turnId: 'turn_01' } })
    expect(calls.find((call) => call.kind === 'turn-start')).toMatchObject({ turn: { sessionId: SESSION, turnId: 'turn_01' } })
    expect(calls.filter((call) => call.kind === 'state').at(-1)).toMatchObject({ state: { state: 'success', turnId: 'turn_01' } })
    connector.handle({ kind: 'session-end', sessionId: SESSION })
    expect(calls).toContainEqual({ kind: 'dispose', sessionId: SESSION })
  })
})
