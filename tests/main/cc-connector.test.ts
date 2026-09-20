/**
 * cc connector: the Claude Code profile on the shared hook-connector engine —
 * event mapping (incl. session-end disposal, the one kind zcode does not
 * have), watchdogs, follow mode and stats recording. Engine-level behaviour
 * is the zcode test suite's contract; these tests pin the CC deltas.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCcConnector } from '../../src/main/connectors/cc-connector'
import type { StateRelay } from '../../src/main/state-relay'
import type { StatsLedger, EditFact, StateFact } from '../../src/main/connectors/stats-ledger'

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

const SESSION = 'cc_11111111-2222-3333-4444-555555555555'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function setup() {
  const { relay, emissions } = fakeRelay()
  return { emissions, deps: { relay, now: () => 1_000 } }
}

describe('event mapping', () => {
  it('session-start emits the idle baseline', () => {
    const { emissions, deps } = setup()
    createCcConnector(deps).handle({ kind: 'session-start', sessionId: SESSION })
    expect(emissions).toEqual([{ method: 'status', sessionId: SESSION, status: 'idle' }])
  })

  it('user-prompt-submit emits turn/start then a reasoning chunk (thinking)', () => {
    const { emissions, deps } = setup()
    createCcConnector(deps).handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    expect(emissions.map((e) => e.event?.type)).toEqual(['turn/start', 'assistant/chunk'])
  })

  it('pre-tool classes fabricate the class-appropriate tool/call name', () => {
    const { emissions, deps } = setup()
    const connector = createCcConnector(deps)
    connector.handle({ kind: 'pre-tool-edit', sessionId: SESSION })
    connector.handle({ kind: 'pre-tool-command', sessionId: SESSION })
    connector.handle({ kind: 'pre-tool-other', sessionId: SESSION })
    expect(emissions.filter((e) => e.method === 'event').map((e) => e.event?.data)).toEqual([
      { name: 'edit' },
      { name: 'bash' },
      { name: 'read' },
    ])
  })

  it('post-tool / permission-request / stop map onto the DSH envelopes', () => {
    const { emissions, deps } = setup()
    const connector = createCcConnector(deps)
    connector.handle({ kind: 'post-tool', sessionId: SESSION })
    connector.handle({ kind: 'permission-request', sessionId: SESSION })
    connector.handle({ kind: 'stop', sessionId: SESSION })
    expect(emissions.map((e) => e.event?.type)).toEqual(['tool/result', 'approval/asked', 'turn/end'])
  })

  it('session-end disposes the session immediately (no idle decay, no visual)', () => {
    const { emissions, deps } = setup()
    const connector = createCcConnector(deps)
    connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    emissions.length = 0

    connector.handle({ kind: 'session-end', sessionId: SESSION })
    expect(emissions).toEqual([{ method: 'disposed', sessionId: SESSION }])
    vi.advanceTimersByTime(3_600_000)
    expect(emissions).toEqual([{ method: 'disposed', sessionId: SESSION }]) // timers died with the session
    expect(connector.status().followTarget).toBeNull()
  })
})

describe('watchdogs', () => {
  it('stop decays to idle after 60s', () => {
    const { emissions, deps } = setup()
    const connector = createCcConnector(deps)
    connector.handle({ kind: 'stop', sessionId: SESSION })
    vi.advanceTimersByTime(60_000)
    expect(emissions.some((e) => e.method === 'status' && e.status === 'idle')).toBe(true)
  })

  it('permission-request decays after 10min', () => {
    const { emissions, deps } = setup()
    const connector = createCcConnector(deps)
    connector.handle({ kind: 'permission-request', sessionId: SESSION })
    vi.advanceTimersByTime(600_000)
    expect(emissions.some((e) => e.method === 'status' && e.status === 'idle')).toBe(true)
  })

  it('inactivity dispose still covers crashed clients (30min)', () => {
    const { emissions, deps } = setup()
    const connector = createCcConnector(deps)
    connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    vi.advanceTimersByTime(1_800_000)
    expect(emissions.some((e) => e.method === 'disposed' && e.sessionId === SESSION)).toBe(true)
  })

  it('reset() drops every live session WITH dispose emissions — the disable semantics', () => {
    const OTHER = 'cc_99999999-8888-7777-6666-555555555555'
    const { emissions, deps } = setup()
    const connector = createCcConnector({ ...deps, isFollowEnabled: () => true })
    connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    connector.handle({ kind: 'user-prompt-submit', sessionId: OTHER })
    connector.handle({ kind: 'stop', sessionId: SESSION })
    emissions.length = 0

    connector.reset()
    // Both sessions released immediately — no waiting for watchdogs.
    expect(emissions.filter((e) => e.method === 'disposed').map((e) => e.sessionId).sort()).toEqual([SESSION, OTHER])
    expect(connector.status().followTarget).toBeNull()
    // Timers died with the sessions: no post-reset emissions ever.
    vi.advanceTimersByTime(3_600_000)
    expect(emissions).toHaveLength(2)
  })
})

describe('follow mode', () => {
  const OTHER = 'cc_99999999-8888-7777-6666-555555555555'

  it('gates background sessions; a focus switch replays and applies the current event', () => {
    const { emissions, deps } = setup()
    const following = createCcConnector({ ...deps, isFollowEnabled: () => true })
    following.handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    following.handle({ kind: 'pre-tool-edit', sessionId: SESSION })
    emissions.length = 0

    following.handle({ kind: 'pre-tool-command', sessionId: OTHER })
    expect(emissions.some((e) => e.sessionId === OTHER)).toBe(false) // gated

    following.handle({ kind: 'user-prompt-submit', sessionId: OTHER }) // switch
    const otherEvents = emissions.filter((e) => e.sessionId === OTHER)
    expect(otherEvents.map((e) => e.event?.type)).toEqual([
      'tool/call', // replayed last visual (pre-tool-command)
      'turn/start', // the focus event itself
      'assistant/chunk',
    ])
    expect(emissions.some((e) => e.sessionId === SESSION && e.method === 'status' && e.status === 'idle')).toBe(true)
  })
})

describe('stats recording (CC payload shape)', () => {
  function fakeLedger(): { ledger: StatsLedger; calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = []
    const ledger = {
      recordState(state: StateFact) {
        calls.push({ kind: 'state', state })
      },
      recordEdit(edit: EditFact) {
        calls.push({ kind: 'edit', edit })
      },
      recordTurnStart(turn: { sessionId: string; at: number; turnId?: string }) {
        calls.push({ kind: 'turn-start', turn })
      },
      setFocus(sessionId: string | null) {
        calls.push({ kind: 'focus', sessionId })
      },
      disposeSession(sessionId: string) {
        calls.push({ kind: 'dispose', sessionId })
      },
      snapshot() {
        return { cursor: 0, focusedSessionId: null, sessions: {}, events: [] }
      },
    } as unknown as StatsLedger
    return { ledger, calls }
  }

  it('prompt_id is the turnId for turn starts and the stop state fact', () => {
    const { ledger, calls } = fakeLedger()
    const { relay } = fakeRelay()
    const connector = createCcConnector({ relay, now: () => 100, stats: ledger })
    connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION, payload: { turnId: 'prompt_7' } })
    connector.handle({ kind: 'stop', sessionId: SESSION, payload: { turnId: 'prompt_7' } })
    expect(calls.find((call) => call.kind === 'turn-start')).toMatchObject({ turn: { sessionId: SESSION, turnId: 'prompt_7' } })
    expect(calls.filter((call) => call.kind === 'state').at(-1)).toMatchObject({ state: { state: 'success', turnId: 'prompt_7' } })
  })

  it('an Edit tool_input (old_string/new_string) records reduced counts', () => {
    const { ledger, calls } = fakeLedger()
    const { relay } = fakeRelay()
    const connector = createCcConnector({ relay, now: () => 100, stats: ledger })
    connector.handle({
      kind: 'pre-tool-edit',
      sessionId: SESSION,
      payload: {
        toolName: 'Edit',
        turnId: 'prompt_7',
        toolInput: { file_path: 'D:/x/a.ts', old_string: 'a\nb', new_string: 'a\nB\nc' },
      },
    })
    expect(calls.find((call) => call.kind === 'edit')?.edit).toMatchObject({
      sessionId: SESSION,
      tool: 'edit',
      filePath: 'D:/x/a.ts',
      added: 2,
      removed: 1,
    })
  })

  it('session-end drops the ledger row', () => {
    const { ledger, calls } = fakeLedger()
    const { relay } = fakeRelay()
    const connector = createCcConnector({ relay, now: () => 100, stats: ledger })
    connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    connector.handle({ kind: 'session-end', sessionId: SESSION })
    expect(calls).toContainEqual({ kind: 'dispose', sessionId: SESSION })
  })
})
