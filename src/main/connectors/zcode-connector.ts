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
 * Follow mode (docs/06 §3.1): with several zcode windows open, the pet can
 * track only the session the user last interacted with instead of the
 * §14.5 aggregate. zcode offers no window-focus signal, so the focus proxy is
 * USER-initiated hook kinds — a prompt submit (or session start/resume)
 * happens in the window the user is typing in. Background sessions keep full
 * bookkeeping (watchdogs, last visual) but emit nothing; on a target switch
 * the previous target is retired with an idle emission (replaces its entry at
 * rank 0 in every aggregate) and the new target's last visual is replayed so
 * the pet reflects it immediately instead of waiting for its next event.
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

/** Events that only fire because the user acted on that session's window. */
const FOCUS_KINDS: ReadonlySet<ZcodeHookKind> = new Set(['session-start', 'user-prompt-submit'])

export interface ZcodeHookInput {
  kind: ZcodeHookKind
  sessionId: string
}

export interface ZcodeConnectorStatus {
  sessionsSeen: number
  lastEventAt: number | null
  lastKind: ZcodeHookKind | null
  /** The followed session in follow mode; null in aggregate mode or before the first focus signal. */
  followTarget: string | null
}

export interface ZcodeConnectorDeps {
  relay: StateRelay
  now(): number
  /** true = follow mode: only the last user-interacted session drives the pet. */
  isFollowEnabled?(): boolean
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
  /** Last hook kind seen (emitted or gated) — the replay source in follow mode. */
  lastKind: ZcodeHookKind | null
}

export function createZcodeConnector(deps: ZcodeConnectorDeps): ZcodeConnector {
  const sessions = new Map<string, SessionState>()
  const status: ZcodeConnectorStatus = { sessionsSeen: 0, lastEventAt: null, lastKind: null, followTarget: null }

  const clearTimers = (state: SessionState): void => {
    if (state.idleTimer !== null) clearTimeout(state.idleTimer)
    state.idleTimer = null
    clearTimeout(state.disposeTimer)
  }

  /**
   * The state-changing emission for a kind (docs/06 §1 minus the turn/start
   * marker, which is visually redundant — both map to active/thinking). Used
   * for live emission and, in follow mode, to replay a session's last visual.
   */
  const emitState = (sessionId: string, kind: ZcodeHookKind, ts: number): void => {
    const event = (type: string, data: unknown): RawSessionEvent => ({ type, time: ts, data })
    switch (kind) {
      case 'session-start':
        deps.relay.emitAgentStatus(sessionId, 'idle')
        break
      case 'user-prompt-submit':
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
        break
      case 'stop':
        deps.relay.emitSessionEvent(sessionId, event('turn/end', { reason: { kind: 'completed' } }))
        break
    }
  }

  /**
   * The turn ended — synthesize the idle transition DSH would send. Also
   * downgrades the session's replay visual so a later follow switch shows
   * idle, not a stale success.
   */
  const scheduleIdle = (sessionId: string, state: SessionState, delayMs: number, reason: string): void => {
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null
      deps.relay.emitAgentStatus(sessionId, 'idle')
      state.lastKind = 'session-start'
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
            if (status.followTarget === sessionId) status.followTarget = null
            deps.log?.(`[petween-zcode] session ${sessionId} disposed (inactivity)`)
          }, DISPOSE_MS),
          lastKind: null,
        }
        sessions.set(sessionId, state)
        status.sessionsSeen += 1
      }
      clearTimers(state)
      // Reschedule the inactivity dispose from this event.
      state.disposeTimer = setTimeout(() => {
        sessions.delete(sessionId)
        deps.relay.emitSessionDisposed(sessionId)
        if (status.followTarget === sessionId) status.followTarget = null
      }, DISPOSE_MS)

      if (deps.isFollowEnabled?.() ?? false) {
        if (FOCUS_KINDS.has(kind)) {
          if (status.followTarget !== sessionId) {
            const previous = status.followTarget
            status.followTarget = sessionId
            if (previous !== null) {
              // Retire the old target: an idle entry replaces its aggregate
              // slot at rank 0, so it can no longer suppress the new target.
              deps.relay.emitAgentStatus(previous, 'idle')
              deps.log?.(`[petween-zcode] follow ${sessionId} (was ${previous})`)
            }
            // Replay the new target's current visual (or this event when it
            // is the first sighting) so the pet switches without waiting for
            // the target's next event.
            emitState(sessionId, state.lastKind ?? kind, ts)
            state.lastKind = kind
            return
          }
          // Same target — the focus event is also just an event; emit below.
        } else if (status.followTarget !== null && sessionId !== status.followTarget) {
          state.lastKind = kind // background session: bookkeeping only
          return
        }
        // followTarget === null: no focus signal yet — aggregate behaviour.
      }

      state.lastKind = kind
      if (kind === 'user-prompt-submit') {
        // turn/start is kept for envelope fidelity with the DSH stream; the
        // visual state itself comes from the reasoning chunk.
        deps.relay.emitSessionEvent(sessionId, { type: 'turn/start', time: ts, data: {} })
      }
      emitState(sessionId, kind, ts)
      switch (kind) {
        case 'permission-request':
          scheduleIdle(sessionId, state, WAITING_IDLE_MS, 'permission stranded')
          break
        case 'stop':
          scheduleIdle(sessionId, state, SUCCESS_IDLE_MS, 'turn ended')
          break
      }
    },

    status: () => ({ ...status }),

    dispose() {
      for (const state of sessions.values()) clearTimers(state)
      sessions.clear()
    },
  }
}
