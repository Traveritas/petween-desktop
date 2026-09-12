/**
 * Bridge FSM tests driven by fake sockets + fake timers (docs/05 Phase 4):
 * probe/degrade, dual-stream open handshake, frame→relay wiring, reconnect
 * with subscribed-baseline diff, and the heartbeat death detector.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDshBridge, type BridgeDeps } from '../../src/main/dsh-bridge/bridge'
import { backoffDelayMs } from '../../src/main/dsh-bridge/backoff'
import type { BridgeSocket } from '../../src/main/dsh-bridge/ws-socket'
import type { StateRelay } from '../../src/main/state-relay'

type Handler = (...args: never[]) => void

class FakeSocket implements BridgeSocket {
  opened = false
  closed = false
  pings = 0
  readonly handlers = {
    open: new Set<Handler>(),
    close: new Set<Handler>(),
    message: new Set<Handler>(),
    pong: new Set<Handler>(),
  }

  onOpen(handler: () => void): void {
    this.handlers.open.add(handler as Handler)
  }
  onClose(handler: (code: number, reason: string) => void): void {
    this.handlers.close.add(handler as Handler)
  }
  onMessage(handler: (data: string) => void): void {
    this.handlers.message.add(handler as Handler)
  }
  onPong(handler: () => void): void {
    this.handlers.pong.add(handler as Handler)
  }
  ping(): void {
    this.pings += 1
  }
  close(): void {
    this.closed = true
  }

  /** Test seams. */
  open(): void {
    this.opened = true
    for (const handler of this.handlers.open) handler()
  }
  remoteClose(code = 1006, reason = 'gone'): void {
    for (const handler of this.handlers.close) handler(code, reason)
  }
  message(data: unknown): void {
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    for (const handler of this.handlers.message) handler(text)
  }
  pong(): void {
    for (const handler of this.handlers.pong) handler()
  }
}

function fakeRelay(): StateRelay & {
  events: { sessionEvents: unknown[][]; disposed: string[]; statuses: unknown[][]; errors: string[] }
} {
  const events = { sessionEvents: [] as unknown[][], disposed: [] as string[], statuses: [] as unknown[][], errors: [] as string[] }
  const host = {
    on: () => () => {},
    webServer: { register: () => () => {} },
  }
  return {
    events,
    host: host as StateRelay['host'],
    emitSessionEvent: (...args: unknown[]) => void events.sessionEvents.push(args),
    emitSessionDisposed: (id: string) => void events.disposed.push(id),
    emitAgentStatus: (...args: unknown[]) => void events.statuses.push(args),
    emitAgentError: (id: string) => void events.errors.push(id),
  }
}

describe('backoff params (official ConnectionController, docs/03 §3.4)', () => {
  it('stays inside the jittered half-window and caps at 10s', () => {
    expect(backoffDelayMs(0, () => 0)).toBe(250) // lower bound attempt 0
    expect(backoffDelayMs(0, () => 1)).toBe(500) // upper bound attempt 0
    expect(backoffDelayMs(1, () => 0.5)).toBe(750)
    expect(backoffDelayMs(50, () => 0)).toBe(5000) // cap/2
    expect(backoffDelayMs(50, () => 1)).toBe(10000) // cap
  })
})

describe('bridge FSM', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeBridge(over: Partial<BridgeDeps> = {}) {
    const relay = fakeRelay()
    const sockets: FakeSocket[] = []
    const statuses: Array<[string, string | undefined]> = []
    const logs: string[] = []
    const deps: BridgeDeps = {
      relay,
      getPort: () => 3080,
      connect: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      describe: vi.fn(async () => ({ version: '0.1.0-rc.7' })),
      log: (message) => logs.push(message),
      onStatus: (status, detail) => statuses.push([status, detail]),
      ...over,
    }
    const bridge = createDshBridge(deps)
    return { bridge, relay, sockets, statuses, logs, deps }
  }

  it('degrades to an idle backoff loop when DSH is absent (no relay events)', async () => {
    const { bridge, relay, statuses } = makeBridge({ describe: vi.fn(async () => null) })
    bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(relay.events.sessionEvents).toHaveLength(0)

    // three failed probes, three backoff waits (500 → 1000 → 2000 window)
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    const disconnected = statuses.filter(([status]) => status === 'disconnected')
    expect(disconnected.length).toBeGreaterThanOrEqual(3)
    expect(relay.events.sessionEvents).toHaveLength(0)
    bridge.close()
  })

  it('connects both streams, resets attempts, and wires frames to the relay', async () => {
    const { bridge, relay, sockets, statuses } = makeBridge()
    bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    // connect() created mux + host sockets; open them.
    expect(sockets).toHaveLength(2)
    sockets[0]!.open()
    sockets[1]!.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses.at(-1)).toEqual(['connected', undefined])

    sockets[0]!.message({
      type: 'server-request',
      rpcId: 'r1',
      method: 'session/event',
      payload: {
        type: 'session/event',
        sessionId: 'session-1',
        event: { type: 'turn/start', time: 1000, seq: 1, data: { turn: {} } },
      },
    })
    sockets[1]!.message({
      type: 'server-request',
      rpcId: 'r2',
      method: 'host/session-status',
      payload: { type: 'host/session-status', sessionId: 'session-1', running: false },
    })
    sockets[1]!.message({
      type: 'server-request',
      rpcId: 'r3',
      method: 'host/agent-error',
      payload: { type: 'host/agent-error', sessionId: 'session-1', message: 'x' },
    })

    expect(relay.events.sessionEvents).toEqual([
      ['session-1', { type: 'turn/start', time: 1000, seq: 1, data: { turn: {} } }],
    ])
    expect(relay.events.statuses).toEqual([['session-1', 'idle']])
    expect(relay.events.errors).toEqual(['session-1'])
    bridge.close()
  })

  it('subscribed frames feed the mounted set; session-removed removes from it', async () => {
    const { bridge, relay, sockets } = makeBridge()
    bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.open()
    sockets[1]!.open()
    await vi.advanceTimersByTimeAsync(0)

    sockets[0]!.message(envelope({ type: 'session/subscribed', sessionId: 'a', lastSeq: 0 }))
    sockets[0]!.message(envelope({ type: 'session/subscribed', sessionId: 'b', lastSeq: 0 }))
    sockets[1]!.message(envelope({ type: 'host/session-removed', sessionId: 'a' }))
    expect(relay.events.disposed).toEqual(['a'])
    bridge.close()
  })

  it('reconnects and reports vanished sessions via the baseline diff (docs/03 §3.5)', async () => {
    const { bridge, relay, sockets, statuses } = makeBridge()
    bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.open()
    sockets[1]!.open()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.message(envelope({ type: 'session/subscribed', sessionId: 'a', lastSeq: 0 }))
    sockets[0]!.message(envelope({ type: 'session/subscribed', sessionId: 'b', lastSeq: 0 }))
    // baseline settles
    await vi.advanceTimersByTimeAsync(1000)

    // DSH restarts: the mux socket dies, reconnect, only b comes back.
    sockets[0]!.remoteClose(1006, 'restart')
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses.at(-1)![0]).toBe('disconnected')
    await vi.advanceTimersByTimeAsync(500) // first backoff window

    const mux2 = sockets.at(-2)!
    const host2 = sockets.at(-1)!
    mux2.open()
    host2.open()
    await vi.advanceTimersByTimeAsync(0)
    mux2.message(envelope({ type: 'session/subscribed', sessionId: 'b', lastSeq: 5 }))
    await vi.advanceTimersByTimeAsync(1000) // baseline settle fires the diff

    expect(relay.events.disposed).toEqual(['a']) // a vanished across the restart
    bridge.close()
  })

  it('declares a stream dead after two missed heartbeat pongs', async () => {
    const { bridge, sockets, statuses } = makeBridge()
    bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.open()
    sockets[1]!.open()
    await vi.advanceTimersByTimeAsync(0)

    // keep mux alive with pongs; let host go silent.
    await vi.advanceTimersByTimeAsync(25_000)
    expect(sockets[0]!.pings).toBe(1)
    sockets[0]!.pong()
    sockets[1]!.pong()
    await vi.advanceTimersByTimeAsync(25_000)
    sockets[0]!.pong()
    // host missed two pongs by now
    await vi.advanceTimersByTimeAsync(25_000)
    expect(statuses.some(([status, detail]) => status === 'disconnected' && detail === 'heartbeat timeout')).toBe(
      true,
    )
    bridge.close()
  })

  it('fails the open handshake after 3s when a stream never opens', async () => {
    const { bridge, sockets, statuses } = makeBridge()
    bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.open() // mux opens, host never does
    await vi.advanceTimersByTimeAsync(3000)
    expect(statuses.some(([status, detail]) => status === 'disconnected' && detail === 'handshake-failed')).toBe(
      true,
    )
    expect(sockets[0]!.closed).toBe(true)
    bridge.close()
  })

  it('close() disposes sockets and stops the loop', async () => {
    const { bridge, sockets } = makeBridge()
    bridge.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]!.open()
    sockets[1]!.open()
    await vi.advanceTimersByTimeAsync(0)
    bridge.close()
    expect(sockets.every((socket) => socket.closed)).toBe(true)
    const created = sockets.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sockets).toHaveLength(created) // no reconnect attempts after close
  })
})

function envelope(payload: unknown): string {
  return JSON.stringify({ type: 'server-request', rpcId: 'rpc', method: 'x', payload })
}
