/**
 * zcode connector: hook kind → RawSessionEvent mapping (docs/06 §1) and the
 * per-session watchdog cascade (§3) — idle decay after stop / stranded
 * permission, inactivity dispose. Timers driven with fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createZcodeConnector, type ZcodeConnectorDeps } from '../../src/main/connectors/zcode-connector'
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

const SESSION = 'sess_11111111-2222-3333-4444-555555555555'

function setup(): { emissions: Emission[]; deps: ZcodeConnectorDeps } {
  const { relay, emissions } = fakeRelay()
  return { emissions, deps: { relay, now: () => 1_000 } }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('event mapping', () => {
  it('session-start emits the idle baseline', () => {
    const { emissions, deps } = setup()
    createZcodeConnector(deps).handle({ kind: 'session-start', sessionId: SESSION })
    expect(emissions).toEqual([{ method: 'status', sessionId: SESSION, status: 'idle' }])
  })

  it('user-prompt-submit emits turn/start then a reasoning chunk (thinking)', () => {
    const { emissions, deps } = setup()
    createZcodeConnector(deps).handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    expect(emissions.map((e) => e.event?.type)).toEqual(['turn/start', 'assistant/chunk'])
    expect(emissions[1].event?.data).toEqual({ chunk: { type: 'reasoning-delta' } })
  })

  it.each([
    ['pre-tool-edit', 'edit'],
    ['pre-tool-command', 'bash'],
    ['pre-tool-other', 'read'],
  ] as const)('%s fabricates tool/call with the class-defining name %s', (kind, name) => {
    const { emissions, deps } = setup()
    createZcodeConnector(deps).handle({ kind, sessionId: SESSION })
    expect(emissions).toEqual([
      { method: 'event', sessionId: SESSION, event: { type: 'tool/call', time: 1_000, data: { name } } },
    ])
  })

  it('post-tool fabricates tool/result', () => {
    const { emissions, deps } = setup()
    createZcodeConnector(deps).handle({ kind: 'post-tool', sessionId: SESSION })
    expect(emissions).toEqual([
      { method: 'event', sessionId: SESSION, event: { type: 'tool/result', time: 1_000, data: {} } },
    ])
  })

  it('permission-request fabricates approval/asked', () => {
    const { emissions, deps } = setup()
    createZcodeConnector(deps).handle({ kind: 'permission-request', sessionId: SESSION })
    expect(emissions).toEqual([
      { method: 'event', sessionId: SESSION, event: { type: 'approval/asked', time: 1_000, data: {} } },
    ])
  })

  it('stop fabricates turn/end completed', () => {
    const { emissions, deps } = setup()
    createZcodeConnector(deps).handle({ kind: 'stop', sessionId: SESSION })
    expect(emissions).toEqual([
      { method: 'event', sessionId: SESSION, event: { type: 'turn/end', time: 1_000, data: { reason: { kind: 'completed' } } } },
    ])
  })

  it('status tracks sessions and the last event', () => {
    const { deps } = setup()
    const connector = createZcodeConnector(deps)
    connector.handle({ kind: 'session-start', sessionId: SESSION })
    connector.handle({ kind: 'user-prompt-submit', sessionId: 'sess_other' })
    const status = connector.status()
    expect(status.sessionsSeen).toBe(2)
    expect(status.lastKind).toBe('user-prompt-submit')
    expect(status.lastEventAt).toBe(1_000)
  })
})

describe('watchdogs', () => {
  it('stop decays to idle after 60s', () => {
    const { emissions, deps } = setup()
    const connector = createZcodeConnector(deps)
    connector.handle({ kind: 'stop', sessionId: SESSION })
    vi.advanceTimersByTime(59_999)
    expect(emissions.filter((e) => e.method === 'status')).toEqual([])
    vi.advanceTimersByTime(1)
    expect(emissions.filter((e) => e.method === 'status')).toEqual([
      { method: 'status', sessionId: SESSION, status: 'idle' },
    ])
  })

  it('a stranded permission prompt decays to idle after 10min', () => {
    const { emissions, deps } = setup()
    const connector = createZcodeConnector(deps)
    connector.handle({ kind: 'permission-request', sessionId: SESSION })
    vi.advanceTimersByTime(600_000)
    expect(emissions.filter((e) => e.method === 'status')).toEqual([
      { method: 'status', sessionId: SESSION, status: 'idle' },
    ])
  })

  it('30min of silence disposes the session; any event reschedules', () => {
    const { emissions, deps } = setup()
    const connector = createZcodeConnector(deps)
    connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    vi.advanceTimersByTime(29 * 60_000)
    connector.handle({ kind: 'pre-tool-other', sessionId: SESSION })
    vi.advanceTimersByTime(29 * 60_000)
    expect(emissions.filter((e) => e.method === 'disposed')).toEqual([])
    vi.advanceTimersByTime(60_000)
    expect(emissions.filter((e) => e.method === 'disposed')).toEqual([
      { method: 'disposed', sessionId: SESSION },
    ])
  })

  it('a new turn cancels the pending success-idle decay', () => {
    const { emissions, deps } = setup()
    const connector = createZcodeConnector(deps)
    connector.handle({ kind: 'stop', sessionId: SESSION })
    connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    vi.advanceTimersByTime(120_000)
    expect(emissions.filter((e) => e.method === 'status' && e.status === 'idle')).toEqual([])
  })

  it('dispose clears every timer', () => {
    const { emissions, deps } = setup()
    const connector = createZcodeConnector(deps)
    connector.handle({ kind: 'stop', sessionId: SESSION })
    connector.dispose()
    vi.advanceTimersByTime(3_600_000)
    expect(emissions).toHaveLength(1) // only the turn/end itself
  })
})

describe('follow mode (latest user-interacted session only)', () => {
  const OTHER = 'sess_99999999-8888-7777-6666-555555555555'

  function setupFollow(): { emissions: Emission[]; deps: ZcodeConnectorDeps; setFollow(v: boolean): void } {
    const { relay, emissions } = fakeRelay()
    let follow = false
    return {
      emissions,
      setFollow: (v: boolean) => {
        follow = v
      },
      deps: { relay, now: () => 1_000, isFollowEnabled: () => follow },
    }
  }

  it('gates background sessions but keeps their bookkeeping for replay', () => {
    const { emissions, deps, setFollow } = setupFollow()
    const connector = createZcodeConnector(deps)
    setFollow(true)
    connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    connector.handle({ kind: 'pre-tool-edit', sessionId: SESSION })
    expect(emissions.filter((e) => e.method === 'event').length).toBeGreaterThanOrEqual(2)

    connector.handle({ kind: 'pre-tool-command', sessionId: OTHER })
    expect(emissions.some((e) => e.sessionId === OTHER)).toBe(false) // gated

    // Switching focus replays OTHER's tracked visual (tool-start command).
    connector.handle({ kind: 'user-prompt-submit', sessionId: OTHER })
    const otherEvents = emissions.filter((e) => e.sessionId === OTHER)
    expect(otherEvents.map((e) => e.event?.type)).toContain('tool/call')
    expect(otherEvents.some((e) => e.method === 'status' && e.status === 'idle')).toBe(false)
    // And retires SESSION with a rank-0 idle.
    expect(emissions.some((e) => e.sessionId === SESSION && e.method === 'status' && e.status === 'idle')).toBe(true)
  })

  it('before the first focus signal, events pass through (aggregate until a target exists)', () => {
    const { emissions, deps, setFollow } = setupFollow()
    const connector = createZcodeConnector(deps)
    setFollow(true)
    connector.handle({ kind: 'pre-tool-other', sessionId: OTHER })
    expect(emissions.some((e) => e.sessionId === OTHER)).toBe(true)
  })

  it('inactivating the target clears it; a focus event on the same target is emitted normally', () => {
    const { emissions, deps, setFollow } = setupFollow()
    const connector = createZcodeConnector(deps)
    setFollow(true)
    connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    const prompts = emissions.filter((e) => e.method === 'event' && e.event?.type === 'assistant/chunk')
    expect(prompts).toHaveLength(2) // no retire/replay churn on repeat focus

    vi.advanceTimersByTime(1_800_000) // inactivity dispose
    expect(connector.status().followTarget).toBeNull()
    expect(emissions.some((e) => e.method === 'disposed' && e.sessionId === SESSION)).toBe(true)
  })

  it('turn follow off and the aggregate resumes for every session', () => {
    const { emissions, deps, setFollow } = setupFollow()
    const connector = createZcodeConnector(deps)
    setFollow(true)
    connector.handle({ kind: 'user-prompt-submit', sessionId: SESSION })
    setFollow(false)
    connector.handle({ kind: 'pre-tool-edit', sessionId: OTHER })
    expect(emissions.some((e) => e.sessionId === OTHER && e.event?.type === 'tool/call')).toBe(true)
  })
})
