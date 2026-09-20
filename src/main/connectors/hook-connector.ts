/**
 * connectors/hook-connector.ts — the GENERIC hook-event connector engine
 * (Phase 15): everything per-agent-CLI-agnostic about turning hook events
 * into pet state. Sessions, watchdogs (stop→idle decay / stranded permission
 * / inactivity dispose), follow mode (docs/06 §3.1), stats recording BEFORE
 * the follow gate, and the DSH-envelope fabrication through the StateRelay
 * seam all live here; per-connector profiles (zcode-connector.ts,
 * cc-connector.ts) supply only the event vocabulary and its mapping.
 *
 * Extracted verbatim from zcode-connector.ts (v0.4.0) — the zcode tests are
 * the behaviour contract for this engine.
 */
import type { RawSessionEvent } from 'petween/integration/dsh/event-normalizer'
import type { StateRelay } from '../state-relay'
import { countEditLines, editToolClass } from './line-count'
import type { StatsLedger } from './stats-ledger'

/** Boundary-normalized hook payload (routes fill this from the CLI's stdin JSON). */
export interface HookPayload {
  toolName?: string
  toolInput?: unknown
  turnId?: string
  /** Epoch ms from the CLI's own timestamp field; absent falls back to arrival time. */
  at?: number
}

export type HookLedgerState = 'idle' | 'thinking' | 'working' | 'waiting' | 'success'

/**
 * Per-connector vocabulary + mapping. Kinds are petween-internal event names
 * (the ?e= value in each cfg URL); a profile may map several CLI events onto
 * one kind (CC's PermissionRequest + Notification → permission-request).
 */
export interface HookConnectorProfile<K extends string> {
  logTag: string
  kinds: readonly K[]
  /** Events that only fire because the user acted on that session's window. */
  focusKinds: ReadonlySet<K>
  /** The hook kind → ledger state cadence the HUD displays. */
  ledgerStateByKind: Record<K, HookLedgerState>
  /** Kinds that open a stats turn (recordTurnStart, with payload.turnId). */
  turnStartKinds: ReadonlySet<K>
  /** Kinds whose state fact carries the payload turnId (zcode/CC: stop only). */
  statsTurnIdKinds: ReadonlySet<K>
  /** Edit-class kinds whose payload feeds recordEdit (counts only). */
  editKinds: ReadonlySet<K>
  /** Fabricated tool name per edit-class kind — must classify via petween's toolKind. */
  toolNameByKind: Partial<Record<K, string>>
  /** The state-changing emission for a kind (live and follow-mode replay). */
  emitVisual(relay: StateRelay, sessionId: string, kind: K, ts: number): void
  /** Kinds that also emit a turn/start marker for envelope fidelity. */
  turnStartEmitKinds?: ReadonlySet<K>
  /** Idle decay plans; after the delay the visual resets to idleResetKind. */
  idleAfter: Partial<Record<K, { delayMs: number; reason: string }>>
  /** Visual a decayed/stale session shows when replayed. */
  idleResetKind: K
  /** Inactivity dispose (zcode 30min; CC sessions self-report SessionEnd). */
  disposeAfterMs: number
  /** Kinds that END the session immediately (CC SessionEnd; zcode has none). */
  disposeKinds?: ReadonlySet<K>
}

export interface HookConnectorStatus<K extends string> {
  sessionsSeen: number
  lastEventAt: number | null
  lastKind: K | null
  /** The followed session in follow mode; null in aggregate mode or before the first focus signal. */
  followTarget: string | null
}

export interface HookConnectorDeps<K extends string> {
  relay: StateRelay
  now(): number
  /** true = follow mode: only the last user-interacted session drives the pet. */
  isFollowEnabled?(): boolean
  /** Stats ledger (optional so pre-Phase-10 tests/wiring stay valid). */
  stats?: StatsLedger
  log?: (message: string) => void
}

export interface HookConnector<K extends string> {
  handle(input: { kind: K; sessionId: string; payload?: HookPayload }): void
  status(): HookConnectorStatus<K>
  dispose(): void
}

/** The edited file's path from a hook payload's tool_input (display metadata, not content). */
function filePathOf(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const path = (toolInput as Record<string, unknown>).file_path ?? (toolInput as Record<string, unknown>).filePath
  return typeof path === 'string' ? path : undefined
}

export function createHookConnector<K extends string>(
  deps: HookConnectorDeps<K>,
  profile: HookConnectorProfile<K>,
): HookConnector<K> {
  const sessions = new Map<string, { idleTimer: ReturnType<typeof setTimeout> | null; disposeTimer: ReturnType<typeof setTimeout> | null; lastKind: K | null }>()
  const status: HookConnectorStatus<K> = { sessionsSeen: 0, lastEventAt: null, lastKind: null, followTarget: null }

  const clearTimers = (state: { idleTimer: ReturnType<typeof setTimeout> | null; disposeTimer: ReturnType<typeof setTimeout> | null }): void => {
    if (state.idleTimer !== null) clearTimeout(state.idleTimer)
    state.idleTimer = null
    if (state.disposeTimer !== null) clearTimeout(state.disposeTimer)
    state.disposeTimer = null
  }

  const disposeSession = (sessionId: string): void => {
    sessions.delete(sessionId)
    deps.relay.emitSessionDisposed(sessionId)
    deps.stats?.disposeSession(sessionId)
    if (status.followTarget === sessionId) status.followTarget = null
  }

  /** (Re)schedule the inactivity dispose — every event pushes it back out. */
  const scheduleDispose = (sessionId: string, state: { disposeTimer: ReturnType<typeof setTimeout> | null }): void => {
    state.disposeTimer = setTimeout(() => {
      disposeSession(sessionId)
      deps.log?.(`[${profile.logTag}] session ${sessionId} disposed (inactivity)`)
    }, profile.disposeAfterMs)
  }

  /**
   * The turn ended — synthesize the idle transition DSH would send. Also
   * downgrades the session's replay visual so a later follow switch shows
   * idle, not a stale success.
   */
  const scheduleIdle = (
    sessionId: string,
    state: { idleTimer: ReturnType<typeof setTimeout> | null; lastKind: K | null },
    delayMs: number,
    reason: string,
  ): void => {
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null
      deps.relay.emitAgentStatus(sessionId, 'idle')
      state.lastKind = profile.idleResetKind
      deps.log?.(`[${profile.logTag}] session ${sessionId} idle (${reason})`)
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
      // CC SessionEnd (and any profile dispose kind): the session is gone —
      // BEFORE scheduling a new inactivity timer (it would fire on the dead
      // session), no emission beyond the dispose.
      if (profile.disposeKinds?.has(kind)) {
        disposeSession(sessionId)
        deps.log?.(`[${profile.logTag}] session ${sessionId} ended`)
        return
      }
      // Reschedule the inactivity dispose from this event.
      scheduleDispose(sessionId, state)

      // Stats bookkeeping — BEFORE the follow gate, so background sessions
      // keep the ledger current exactly like they keep watchdogs.
      if (deps.stats !== undefined) {
        const at = payload?.at ?? ts
        deps.stats.recordState({
          sessionId,
          state: profile.ledgerStateByKind[kind],
          at,
          turnId: profile.statsTurnIdKinds.has(kind) ? payload?.turnId : undefined,
        })
        if (profile.turnStartKinds.has(kind)) {
          deps.stats.recordTurnStart({ sessionId, at, turnId: payload?.turnId })
        }
        if (profile.editKinds.has(kind) && payload !== undefined) {
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

      // CC SessionEnd (and any profile dispose kind) is handled right after
      // clearTimers above — nothing further applies to a dead session.

      if (deps.isFollowEnabled?.() ?? false) {
        if (profile.focusKinds.has(kind)) {
          if (status.followTarget !== sessionId) {
            const previous = status.followTarget
            status.followTarget = sessionId
            if (previous !== null) {
              // Retire the old target: an idle entry replaces its aggregate
              // slot at rank 0, so it can no longer suppress the new target.
              deps.relay.emitAgentStatus(previous, 'idle')
              deps.log?.(`[${profile.logTag}] follow ${sessionId} (was ${previous})`)
            }
            // Replay the new target's last visual only when it differs from
            // this event — the event itself is emitted below, so the switch
            // both reflects history and applies the current event (a gated
            // background stop no longer swallows the focus event's thinking).
            if (state.lastKind !== null && state.lastKind !== kind) {
              profile.emitVisual(deps.relay, sessionId, state.lastKind, ts)
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
      if (profile.turnStartEmitKinds?.has(kind)) {
        // turn/start is kept for envelope fidelity with the DSH stream; the
        // visual state itself comes from the following emission.
        deps.relay.emitSessionEvent(sessionId, { type: 'turn/start', time: ts, data: {} })
      }
      profile.emitVisual(deps.relay, sessionId, kind, ts)
      deps.stats?.setFocus(sessionId)
      const idle = profile.idleAfter[kind]
      if (idle !== undefined) scheduleIdle(sessionId, state, idle.delayMs, idle.reason)
    },

    status: () => ({ ...status }),

    dispose() {
      for (const state of sessions.values()) clearTimers(state)
      sessions.clear()
    },
  }
}

/** Event factory shared by profile.emitVisual implementations. */
export function envelope(type: string, ts: number, data: unknown): RawSessionEvent {
  return { type, time: ts, data }
}
