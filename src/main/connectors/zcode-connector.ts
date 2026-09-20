/**
 * connectors/zcode-connector.ts — zcode hook events → StateRelay (docs/06 §1/§3).
 *
 * The connector fabricates DSH-shaped RawSessionEvent envelopes so the existing
 * normalizeSessionEvent → state-adapter chain is reused verbatim (petween stays
 * untouched). Event kind + session id arrive as scalars from the HTTP endpoint;
 * since Phase 10 the endpoint also forwards the hook stdin's tool payload,
 * which feeds the stats ledger (thinking time + edit line counts) BEFORE the
 * follow gate — background sessions record stats but still emit nothing.
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
import { countEditLines, editToolClass } from './line-count'
import type { StatsLedger } from './stats-ledger'

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
  /**
   * Phase 10: the hook stdin JSON fields the ledger needs (docs/06 §8).
   * Absent for legacy `--data-urlencode` hook installs (pre-payload).
   */
  payload?: ZcodeHookPayload
}

/** The subset of zcode's hook stdin the app consumes (snake/camel both accepted at the boundary). */
export interface ZcodeHookPayload {
  toolName?: string
  toolInput?: unknown
  turnId?: string
  /** Epoch ms from zcode's own `timestamp` field; absent falls back to arrival time. */
  at?: number
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
  /**
   * Phase 10 stats ledger (optional so pre-Phase-10 tests/wiring stay valid).
   * Recording happens BEFORE the follow gate: background sessions keep full
   * bookkeeping, exactly like the watchdog state they already share.
   */
  stats?: StatsLedger
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

/** Hook kind → ledger state (Phase 10): the thinking/working/waiting cadence the HUD displays. */
const LEDGER_STATE_BY_KIND: Record<ZcodeHookKind, 'idle' | 'thinking' | 'working' | 'waiting' | 'success'> = {
  'session-start': 'idle',
  'user-prompt-submit': 'thinking',
  'pre-tool-edit': 'working',
  'pre-tool-command': 'working',
  'pre-tool-other': 'working',
  'post-tool': 'thinking',
  'permission-request': 'waiting',
  stop: 'success',
}

const SUCCESS_IDLE_MS = 60_000
const WAITING_IDLE_MS = 600_000
const DISPOSE_MS = 1_800_000

/** The edited file's path from a hook payload's tool_input (display metadata, not content). */
function filePathOf(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const path = (toolInput as Record<string, unknown>).file_path ?? (toolInput as Record<string, unknown>).filePath
  return typeof path === 'string' ? path : undefined
}

interface SessionState {
  idleTimer: ReturnType<typeof setTimeout> | null
  disposeTimer: ReturnType<typeof setTimeout> | null
  /** Last hook kind seen (emitted or gated) — the replay source in follow mode. */
  lastKind: ZcodeHookKind | null
}

export function createZcodeConnector(deps: ZcodeConnectorDeps): ZcodeConnector {
  const sessions = new Map<string, SessionState>()
  const status: ZcodeConnectorStatus = { sessionsSeen: 0, lastEventAt: null, lastKind: null, followTarget: null }

  const clearTimers = (state: SessionState): void => {
    if (state.idleTimer !== null) clearTimeout(state.idleTimer)
    state.idleTimer = null
    if (state.disposeTimer !== null) clearTimeout(state.disposeTimer)
    state.disposeTimer = null
  }

  /** (Re)schedule the inactivity dispose — every event pushes it back out. */
  const scheduleDispose = (sessionId: string, state: SessionState): void => {
    state.disposeTimer = setTimeout(() => {
      sessions.delete(sessionId)
      deps.relay.emitSessionDisposed(sessionId)
      deps.stats?.disposeSession(sessionId)
      if (status.followTarget === sessionId) status.followTarget = null
      deps.log?.(`[petween-zcode] session ${sessionId} disposed (inactivity)`)
    }, DISPOSE_MS)
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
    handle({ kind, sessionId, payload }) {
      const ts = deps.now()
      status.lastEventAt = ts
      status.lastKind = kind

      let state = sessions.get(sessionId)
      if (state === undefined) {
        state = { idleTimer: null, disposeTimer: null, lastKind: null }
        sessions.set(sessionId, state)
        status.sessionsSeen += 1
      }
      clearTimers(state)
      // Reschedule the inactivity dispose from this event.
      scheduleDispose(sessionId, state)

      // Phase 10 stats bookkeeping — BEFORE the follow gate, so background
      // sessions keep the ledger current exactly like they keep watchdogs.
      if (deps.stats !== undefined) {
        const at = payload?.at ?? ts
        deps.stats.recordState({
          sessionId,
          state: LEDGER_STATE_BY_KIND[kind],
          at,
          turnId: kind === 'stop' ? payload?.turnId : undefined,
        })
        if (kind === 'user-prompt-submit') {
          deps.stats.recordTurnStart({ sessionId, at, turnId: payload?.turnId })
        }
        if (kind === 'pre-tool-edit' && payload !== undefined) {
          const counts = countEditLines(payload.toolName, payload.toolInput)
          deps.stats.recordEdit({
            sessionId,
            at,
            turnId: payload.turnId,
            tool: editToolClass(payload.toolName),
            filePath: filePathOf(payload.toolInput),
            added: counts === null ? null : counts.added,
            removed: counts === null ? null : counts.removed,
          })
        }
      }

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
            // Replay the new target's last visual only when it differs from
            // this event — the event itself is emitted below, so the switch
            // both reflects history and applies the current event (a gated
            // background stop no longer swallows the focus event's thinking).
            if (state.lastKind !== null && state.lastKind !== kind) {
              emitState(sessionId, state.lastKind, ts)
            }
          }
          // Same or new target — the focus event is also just an event; emit below.
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
      deps.stats?.setFocus(sessionId)
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
