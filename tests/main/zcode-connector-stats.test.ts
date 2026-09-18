/**
 * zcode connector → stats ledger wiring (Phase 10): every kind records its
 * ledger state, pre-tool-edit payloads reduce to line counts, background
 * sessions in follow mode keep recording, focus follows the pet-driving
 * session, and the inactivity watchdog disposes the ledger row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createZcodeConnector, type ZcodeConnectorDeps } from '../../src/main/connectors/zcode-connector'
import type { StatsLedger, EditFact, StateFact } from '../../src/main/connectors/stats-ledger'
import type { StateRelay } from '../../src/main/state-relay'

interface LedgerCall {
  kind: 'state' | 'edit' | 'focus' | 'dispose'
  state?: StateFact
  edit?: EditFact
  sessionId?: string
}

function fakeLedger(): { ledger: StatsLedger; calls: LedgerCall[] } {
  const calls: LedgerCall[] = []
  const ledger = {
    recordState(state: StateFact) {
      calls.push({ kind: 'state', state })
    },
    recordEdit(edit: EditFact) {
      calls.push({ kind: 'edit', edit })
    },
    setFocus(sessionId: string | null) {
      calls.push({ kind: 'focus', sessionId: sessionId ?? '' })
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

const relay = {
  emitSessionEvent: () => {},
  emitSessionDisposed: () => {},
  emitAgentStatus: () => {},
  emitAgentError: () => {},
} as unknown as StateRelay

const S1 = 'sess_11111111-2222-3333-4444-555555555555'
const S2 = 'sess_99999999-8888-7777-6666-555555555555'

let now = 0

beforeEach(() => {
  vi.useFakeTimers()
  now = 0
})

afterEach(() => {
  vi.useRealTimers()
})

function setup(options?: { follow?: boolean }) {
  const { ledger, calls } = fakeLedger()
  const connector = createZcodeConnector({
    relay,
    now: () => now,
    stats: ledger,
    isFollowEnabled: () => options?.follow ?? false,
  })
  return { connector, calls }
}

describe('state recording', () => {
  it.each([
    ['session-start', 'idle'],
    ['user-prompt-submit', 'thinking'],
    ['pre-tool-edit', 'working'],
    ['pre-tool-command', 'working'],
    ['pre-tool-other', 'working'],
    ['post-tool', 'thinking'],
    ['permission-request', 'waiting'],
    ['stop', 'success'],
  ] as const)('%s records ledger state %s', (kind, state) => {
    const { connector, calls } = setup()
    now = 1234
    connector.handle({ kind, sessionId: S1 })
    expect(calls.filter((call) => call.kind === 'state')).toEqual([
      { kind: 'state', state: { sessionId: S1, state, at: 1234 } },
    ])
  })

  it('prefers the payload timestamp over arrival time', () => {
    const { connector, calls } = setup()
    now = 5000
    connector.handle({ kind: 'stop', sessionId: S1, payload: { at: 4000 } })
    expect(calls.find((call) => call.kind === 'state')?.state?.at).toBe(4000)
  })
})

describe('edit facts', () => {
  it('pre-tool-edit with an Edit payload records reduced counts', () => {
    const { connector, calls } = setup()
    connector.handle({
      kind: 'pre-tool-edit',
      sessionId: S1,
      payload: {
        toolName: 'Edit',
        at: 900,
        turnId: 'turn_1',
        toolInput: { file_path: 'D:/x/a.ts', old_string: 'a\nb', new_string: 'a\nB\nc' },
      },
    })
    const edit = calls.find((call) => call.kind === 'edit')?.edit
    expect(edit).toEqual({
      sessionId: S1,
      at: 900,
      turnId: 'turn_1',
      tool: 'edit',
      filePath: 'D:/x/a.ts',
      added: 2,
      removed: 1,
    })
  })

  it('payload-less legacy hooks record state only (no edit fact)', () => {
    const { connector, calls } = setup()
    connector.handle({ kind: 'pre-tool-edit', sessionId: S1 })
    expect(calls.some((call) => call.kind === 'edit')).toBe(false)
    expect(calls.some((call) => call.kind === 'state')).toBe(true)
  })

  it('unrecognized tool_input still records the edit with null counts', () => {
    const { connector, calls } = setup()
    connector.handle({
      kind: 'pre-tool-edit',
      sessionId: S1,
      payload: { toolName: 'Edit', toolInput: { mystery: true } },
    })
    const edit = calls.find((call) => call.kind === 'edit')?.edit
    expect(edit).toMatchObject({ added: null, removed: null, tool: 'edit' })
  })
})

describe('follow mode', () => {
  it('background sessions record stats but never take focus', () => {
    const { connector, calls } = setup({ follow: true })
    connector.handle({ kind: 'user-prompt-submit', sessionId: S1 })
    connector.handle({ kind: 'pre-tool-edit', sessionId: S2 })
    const s2Focus = calls.some((call) => call.kind === 'focus' && call.sessionId === S2)
    expect(s2Focus).toBe(false)
    expect(calls.some((call) => call.kind === 'state' && call.state?.sessionId === S2)).toBe(true)
    expect(calls.filter((call) => call.kind === 'focus').at(-1)?.sessionId).toBe(S1)
  })

  it('focus switches to the new follow target', () => {
    const { connector, calls } = setup({ follow: true })
    connector.handle({ kind: 'user-prompt-submit', sessionId: S1 })
    connector.handle({ kind: 'user-prompt-submit', sessionId: S2 })
    expect(calls.filter((call) => call.kind === 'focus').at(-1)?.sessionId).toBe(S2)
  })
})

describe('watchdog interplay', () => {
  it('the inactivity dispose drops the ledger row', () => {
    const { connector, calls } = setup()
    connector.handle({ kind: 'user-prompt-submit', sessionId: S1 })
    vi.advanceTimersByTime(30 * 60 * 1000 + 10)
    expect(calls).toContainEqual({ kind: 'dispose', sessionId: S1 })
  })
})
