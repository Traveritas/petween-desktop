/**
 * connectors/zcode-connector.ts — zcode hook events → StateRelay (docs/06 §1/§3).
 *
 * The connector fabricates DSH-shaped RawSessionEvent envelopes so the existing
 * normalizeSessionEvent → state-adapter chain is reused verbatim (petween stays
 * untouched). Event kind + session id arrive as two scalars from the HTTP
 * endpoint; no hook stdin is ever parsed.
 *
 * Watchdogs per session (zcode has no SessionEnd and no turn-level agent
 * status, so the connector synthesizes both):
 * - stop → agent/status idle after 60s (success face decays back to ambient);
 * - permission-request → idle after 10min (a stranded approval prompt);
 * - any event → session/disposed after 30min of silence (memory + a crashed
 *   zcode client can otherwise leave the pet stuck working forever).
 * thinking/working deliberately have no short timeout — tools may run long.
 *
 * Pure Node; timers are real setTimeout (tests drive them with fake timers,
 * same pattern as the DSH bridge).
 */
import type { RawSessionEvent } from 'petween/integration/dsh/event-normalizer'
import type { StateRelay } from '../state-relay'

export type ZcodeHookKind =
  | 'session-start'
  | 'user-prompt-submit'
  | 'pre-tool-edit'
  | 'pre-tool-command'
  | 'pre-tool-other'
  | 'post-tool'
  | 'permission-request'
  | 'stop'

export const ZCODE_HOOK_KINDS: readonly ZcodeHookKind[] = [
  'session-start',
  'user-prompt-submit',
  'pre-tool-edit',
  'pre-tool-command',
  'pre-tool-other',
  'post-tool',
  'permission-request',
  'stop',
]

export interface ZcodeHookInput {
  kind: ZcodeHookKind
  sessionId: string
}

export interface ZcodeConnectorStatus {
  sessionsSeen: number
  lastEventAt: number | null
  lastKind: ZcodeHookKind | null
}

export interface ZcodeConnectorDeps {
  relay: StateRelay
  now(): number
  log?: (message: string) => void
}

export interface ZcodeConnector {
  handle(input: ZcodeHookInput): void
  status(): ZcodeConnectorStatus
  dispose(): void
}

/** Tool name fabricated per pre-tool class — chosen so normalizeSessionEvent's classifyTool lands on the intended toolKind ('edit'/'command'/'other'). */
const TOOL_NAME_BY_KIND: Record<string, string> = {
  'pre-tool-edit': 'edit',
  'pre-tool-command': 'bash',
  'pre-tool-other': 'read',
}

const SUCCESS_IDLE_MS = 60_000
const WAITING_IDLE_MS = 600_000
const DISPOSE_MS = 1_800_000

interface SessionState {
  idleTimer: ReturnType<typeof setTimeout> | null
  disposeTimer: ReturnType<typeof setTimeout>
}

export function createZcodeConnector(deps: ZcodeConnectorDeps): ZcodeConnector {
  const sessions = new Map<string, SessionState>()
  const status: ZcodeConnectorStatus = { sessionsSeen: 0, lastEventAt: null, lastKind: null }

  const clearTimers = (state: SessionState): void => {
    if (state.idleTimer !== null) clearTimeout(state.idleTimer)
    state.idleTimer = null
    clearTimeout(state.disposeTimer)
  }

  /** The turn ended — synthesize the idle transition DSH would send. */
  const scheduleIdle = (sessionId: string, state: SessionState, delayMs: number, reason: string): void => {
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null
      deps.relay.emitAgentStatus(sessionId, 'idle')
      deps.log?.(`[petween-zcode] session ${sessionId} idle (${reason})`)
    }, delayMs)
  }

  return {
    handle({ kind, sessionId }) {
      const ts = deps.now()
      status.lastEventAt = ts
      status.lastKind = kind

      let state = sessions.get(sessionId)
      if (state === undefined) {
        state = {
          idleTimer: null,
          disposeTimer: setTimeout(() => {
            sessions.delete(sessionId)
            deps.relay.emitSessionDisposed(sessionId)
            deps.log?.(`[petween-zcode] session ${sessionId} disposed (inactivity)`)
          }, DISPOSE_MS),
        }
        sessions.set(sessionId, state)
        status.sessionsSeen += 1
      }
      clearTimers(state)
      // Reschedule the inactivity dispose from this event.
      state.disposeTimer = setTimeout(() => {
        sessions.delete(sessionId)
        deps.relay.emitSessionDisposed(sessionId)
      }, DISPOSE_MS)

      const event = (type: string, data: unknown): RawSessionEvent => ({ type, time: ts, data })
      switch (kind) {
        case 'session-start':
          // Baseline: clears a stale success face on resume; harmless on startup.
          deps.relay.emitAgentStatus(sessionId, 'idle')
          break
        case 'user-prompt-submit':
          deps.relay.emitSessionEvent(sessionId, event('turn/start', {}))
          deps.relay.emitSessionEvent(sessionId, event('assistant/chunk', { chunk: { type: 'reasoning-delta' } }))
          break
        case 'pre-tool-edit':
        case 'pre-tool-command':
        case 'pre-tool-other':
          deps.relay.emitSessionEvent(sessionId, event('tool/call', { name: TOOL_NAME_BY_KIND[kind] }))
          break
        case 'post-tool':
          deps.relay.emitSessionEvent(sessionId, event('tool/result', {}))
          break
        case 'permission-request':
          deps.relay.emitSessionEvent(sessionId, event('approval/asked', {}))
          scheduleIdle(sessionId, state, WAITING_IDLE_MS, 'permission stranded')
          return
        case 'stop':
          deps.relay.emitSessionEvent(sessionId, event('turn/end', { reason: { kind: 'completed' } }))
          scheduleIdle(sessionId, state, SUCCESS_IDLE_MS, 'turn ended')
          return
      }
    },

    status: () => ({ ...status }),

    dispose() {
      for (const state of sessions.values()) clearTimers(state)
      sessions.clear()
    },
  }
}
