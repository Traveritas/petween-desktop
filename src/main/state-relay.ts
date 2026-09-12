/**
 * state-relay.ts — the StateChannelHost seam (docs/03 §1.4). petween's
 * attachStateChannel subscribes its four listeners here; the DSH bridge
 * (Phase 4) drives the emit* methods with frames converted from the two WS
 * downlink streams. Until then nothing fires and the SSE endpoints simply
 * stream heartbeats — the desktop pet stays idle (pure decoration mode).
 *
 * Pure Node, no Electron.
 */
import type { RawSessionEvent } from 'petween/integration/dsh/event-normalizer'
import type { StateChannelHost } from 'petween/host/state-channel'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

type SessionEventListener = (session: { id: string }, event: RawSessionEvent) => void
type SessionDisposedListener = (session: { id: string }) => void
type AgentStatusListener = (payload: { agent: { id: string }; status: string }) => void
type AgentErrorListener = (payload: { agent: { id: string } }) => void

export interface StateRelay {
  /** The StateChannelHost facade handed to attachStateChannel. */
  readonly host: StateChannelHost
  emitSessionEvent(sessionId: string, event: RawSessionEvent): void
  emitSessionDisposed(sessionId: string): void
  emitAgentStatus(sessionId: string, status: string): void
  emitAgentError(sessionId: string): void
}

export function createStateRelay(webServer: { register(route: WebRoute): () => void }): StateRelay {
  const sessionEvent = new Set<SessionEventListener>()
  const sessionDisposed = new Set<SessionDisposedListener>()
  const agentStatus = new Set<AgentStatusListener>()
  const agentError = new Set<AgentErrorListener>()

  // One handler per event name: attachStateChannel registers exactly once per
  // name and stores the returned unsubscribe functions.
  const host: StateChannelHost = {
    on(name, listener) {
      // The four overloads guarantee one of these branches; the cast keeps
      // the generic dispatch out of the typed API surface.
      const set = {
        'session/event': sessionEvent,
        'session/disposed': sessionDisposed,
        'agent/status': agentStatus,
        'agent/error': agentError,
      }[name as 'session/event'] as Set<(session: { id: string }) => void>
      set.add(listener as (session: { id: string }) => void)
      return () => {
        set.delete(listener as (session: { id: string }) => void)
      }
    },
    webServer,
  }

  return {
    host,
    emitSessionEvent(id, event) {
      for (const listener of sessionEvent) listener({ id }, event)
    },
    emitSessionDisposed(id) {
      for (const listener of sessionDisposed) listener({ id })
    },
    emitAgentStatus(id, status) {
      for (const listener of agentStatus) listener({ agent: { id }, status })
    },
    emitAgentError(id) {
      for (const listener of agentError) listener({ agent: { id } })
    },
  }
}
