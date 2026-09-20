/**
 * dsh-bridge/bridge.ts — the connection lifecycle state machine (docs/03 §3).
 *
 * Every generation: probe /api/host.describe → open BOTH WS streams (mux for
 * session events, host for disposed/status/error — the mux stream has no
 * disposed signal) → 3s open handshake → running (attempt resets, 25s ping /
 * 2-missed-pong heartbeat). Any stream termination → dispose → backoff
 * (official 500ms×2→10s jittered) → next generation.
 *
 * Reconnect truth (docs/03 §3.5): the new generation's subscribed baseline
 * replaces the old mounted set; sessions that vanished in between are
 * reported as session/disposed so the aggregate falls back to idle. `since`
 * incremental resume is intentionally NOT used (unimplemented upstream).
 *
 * When DSH is absent the loop keeps retrying in the background and emits
 * nothing — the pet stays in pure-decoration idle mode.
 *
 * All I/O is injected (sockets, describe, clock-backed waits via real
 * setTimeout) so the FSM is driven by fakes + fake timers in tests.
 */
import { backoffDelayMs } from './backoff'
import {
  interpretHostFrame,
  interpretMuxFrame,
  parseServerFrame,
} from './frames'
import type { BridgeSocket } from './ws-socket'
import type { DshDescribe } from './dsh-client'
import type { StateRelay } from '../state-relay'

export type BridgeStatus = 'disconnected' | 'connecting' | 'connected'

export interface BridgeDeps {
  relay: StateRelay
  /** Resolved fresh every cycle (user setting → default 3080). */
  getPort(): number
  connect(url: string): BridgeSocket
  describe(port: number): Promise<DshDescribe | null>
  log?: (message: string) => void
  onStatus?: (status: BridgeStatus, detail?: string) => void
}

const OPEN_HANDSHAKE_MS = 3_000
const HEARTBEAT_INTERVAL_MS = 25_000
const HEARTBEAT_DEAD_MS = 50_000 // two missed pongs
const BASELINE_SETTLE_MS = 1_000 // loopback baseline arrives in ms; this only seals the diff window

interface Generation {
  epoch: number
  mounted: Set<string>
  ended: Promise<string>
  end: (reason: string) => void
  sockets: BridgeSocket[]
  timers: Set<ReturnType<typeof setTimeout>>
  lastPong: Map<BridgeSocket, number>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createDshBridge(deps: BridgeDeps): { start(): void; close(): void } {
  let epoch = 0
  let closed = false
  let attempt = 0
  let running: Generation | null = null
  /** The mounted set of the previous generation — diff source after reconnect. */
  let prevMounted: Set<string> | null = null

  const log = (message: string): void => deps.log?.(`[petween-dsh] ${message}`)
  const setStatus = (status: BridgeStatus, detail?: string): void => {
    deps.onStatus?.(status, detail)
  }

  const disposeGeneration = (gen: Generation): void => {
    for (const timer of gen.timers) clearTimeout(timer)
    gen.timers.clear()
    for (const socket of gen.sockets) socket.close()
    gen.sockets.length = 0
  }

  const endStream = (gen: Generation, reason: string): void => {
    gen.end(reason)
  }

  async function runLoop(): Promise<void> {
    while (!closed) {
      setStatus('connecting')
      const port = deps.getPort()
      const describe = await deps.describe(port)
      if (closed) return
      if (describe === null) {
        log(`no DSH on 127.0.0.1:${port} (attempt ${attempt + 1})`)
        setStatus('disconnected', 'probe-failed')
        await sleep(backoffDelayMs(attempt))
        attempt += 1
        continue
      }

      const myEpoch = ++epoch
      const mux = deps.connect(`ws://127.0.0.1:${port}/api/events.mux`)
      const host = deps.connect(`ws://127.0.0.1:${port}/api/events.host`)

      const opened = await Promise.race([
        Promise.all([openOf(mux), openOf(host)]).then(
          (results) => results.every(Boolean),
          () => false,
        ),
        sleep(OPEN_HANDSHAKE_MS).then(() => false),
      ])
      if (closed || myEpoch !== epoch) {
        mux.close()
        host.close()
        return
      }
      if (!opened) {
        mux.close()
        host.close()
        log(`open handshake failed (attempt ${attempt + 1})`)
        setStatus('disconnected', 'handshake-failed')
        await sleep(backoffDelayMs(attempt))
        attempt += 1
        continue
      }

      attempt = 0
      let end!: (reason: string) => void
      const ended = new Promise<string>((resolve) => {
        end = resolve
      })
      const gen: Generation = {
        epoch: myEpoch,
        mounted: new Set(),
        ended,
        end: (reason) => end(reason),
        sockets: [mux, host],
        timers: new Set(),
        lastPong: new Map(),
      }
      running = gen
      log(`connected to DSH ${describe.version} on :${port}`)
      setStatus('connected')

      const wire = (socket: BridgeSocket): void => {
        gen.lastPong.set(socket, Date.now())
        socket.onPong(() => gen.lastPong.set(socket, Date.now()))
        socket.onClose((code, reasonText) => {
          if (gen.epoch === epoch) endStream(gen, `socket close ${code} ${reasonText}`)
        })
      }
      wire(mux)
      wire(host)

      mux.onMessage((data) => {
        if (gen.epoch !== epoch) return
        gen.lastPong.set(mux, Date.now())
        const action = interpretMuxFrame(parseServerFrame(data)?.payload)
        switch (action.kind) {
          case 'session-event':
            deps.relay.emitSessionEvent(action.sessionId, action.event)
            break
          case 'subscribed':
            gen.mounted.add(action.sessionId)
            break
          case 'stream-error':
            endStream(gen, 'mux stream/error')
            break
          default:
            break
        }
      })

      host.onMessage((data) => {
        if (gen.epoch !== epoch) return
        gen.lastPong.set(host, Date.now())
        const action = interpretHostFrame(parseServerFrame(data)?.payload)
        switch (action.kind) {
          case 'session-removed':
            gen.mounted.delete(action.sessionId)
            deps.relay.emitSessionDisposed(action.sessionId)
            break
          case 'session-status':
            deps.relay.emitAgentStatus(action.sessionId, action.running ? 'running' : 'idle')
            break
          case 'agent-error':
            deps.relay.emitAgentError(action.sessionId)
            break
          default:
            break
        }
      })

      // Seal the reconnect diff: the new subscribed baseline is now truth.
      const baselineTimer = setTimeout(() => {
        gen.timers.delete(baselineTimer)
        if (gen.epoch !== epoch || prevMounted === null) return
        for (const sessionId of prevMounted) {
          if (!gen.mounted.has(sessionId)) {
            log(`session ${sessionId} gone after reconnect — disposed`)
            deps.relay.emitSessionDisposed(sessionId)
          }
        }
        prevMounted = null
      }, BASELINE_SETTLE_MS)
      gen.timers.add(baselineTimer)

      const beat = (): void => {
        if (gen.epoch !== epoch || closed) return
        // Two unanswered pings (= pong older than two intervals) = dead link.
        const dead = [...gen.sockets].some(
          (socket) => Date.now() - (gen.lastPong.get(socket) ?? 0) >= HEARTBEAT_DEAD_MS,
        )
        if (dead) {
          endStream(gen, 'heartbeat timeout')
          return
        }
        for (const socket of gen.sockets) socket.ping()
        const heartbeatTimer = setTimeout(beat, HEARTBEAT_INTERVAL_MS)
        gen.timers.add(heartbeatTimer)
      }
      const heartbeatTimer = setTimeout(beat, HEARTBEAT_INTERVAL_MS)
      gen.timers.add(heartbeatTimer)

      const reason = await gen.ended
      if (gen.epoch !== epoch) return
      epoch += 1 // invalidate stray callbacks from this generation
      disposeGeneration(gen)
      running = null
      prevMounted = gen.mounted
      log(`stream ended: ${reason}`)
      setStatus('disconnected', reason)
      if (closed) return
      await sleep(backoffDelayMs(attempt))
      attempt += 1
    }
  }

  let loop: Promise<void> | null = null
  return {
    start() {
      if (loop !== null || closed) return
      // Crash recovery (v0.7.1 backlog fix): runLoop only EXITS by throwing
      // (crash) or by epoch guard (close/supersede). Previously a crash left
      // loop non-null forever — only the settings toggle could revive the
      // bridge. Now: log, back off, restart — until close().
      loop = (async (): Promise<void> => {
        for (;;) {
          if (closed) return
          try {
            await runLoop()
            return // epoch-guarded exit — nothing to restart
          } catch (error: unknown) {
            log(`loop crashed: ${String(error)}`)
            setStatus('disconnected', 'crashed')
            if (closed) return
            await sleep(backoffDelayMs(attempt))
            attempt += 1
          }
        }
      })()
    },
    close() {
      if (closed) return
      closed = true
      epoch += 1
      if (running !== null) {
        running.end('bridge closed')
        disposeGeneration(running)
        running = null
      }
      setStatus('disconnected', 'closed')
    },
  }
}

function openOf(socket: BridgeSocket): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    socket.onOpen(() => done(true))
    socket.onClose(() => done(false))
  })
}
