/**
 * connectors/zcode-connector.ts — the zcode profile on the generic hook
 * connector engine (hook-connector.ts): the event vocabulary (docs/06 §1/§3)
 * and its mapping. The engine (sessions, watchdogs, follow mode, stats
 * recording, StateRelay emission) is shared with the Claude Code connector
 * since Phase 15; the zcode tests are the engine's behaviour contract.
 *
 * The connector fabricates DSH-shaped RawSessionEvent envelopes so the existing
 * normalizeSessionEvent → state-adapter chain is reused verbatim (petween stays
 * untouched). Event kind + session id arrive as scalars from the HTTP endpoint;
 * the endpoint also forwards the hook stdin's tool payload, which feeds the
 * stats ledger (thinking time + edit line counts) BEFORE the follow gate —
 * background sessions record stats but still emit nothing.
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
 * §14.5 aggregate. The focus proxy is USER-initiated hook kinds — a prompt
 * submit (or session start/resume) happens in the window the user is typing
 * in. Background sessions keep full bookkeeping (watchdogs, last visual) but
 * emit nothing; on a target switch the previous target is retired with an
 * idle emission (replaces its entry at rank 0 in every aggregate) and the
 * new target's last visual is replayed before the current event applies.
 */
import type { StateRelay } from '../state-relay'
import { createHookConnector, envelope, type HookConnector, type HookConnectorDeps, type HookConnectorProfile, type HookLedgerState, type HookPayload } from './hook-connector'

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

export type ZcodeHookPayload = HookPayload

export interface ZcodeHookInput {
  kind: ZcodeHookKind
  sessionId: string
  /**
   * Phase 10: the hook stdin JSON fields the ledger needs (docs/06 §8).
   * Absent for legacy `--data-urlencode` hook installs (pre-payload).
   */
  payload?: ZcodeHookPayload
}

export type ZcodeConnectorStatus = {
  sessionsSeen: number
  lastEventAt: number | null
  lastKind: ZcodeHookKind | null
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
  stats?: HookConnectorDeps<ZcodeHookKind>['stats']
  log?: (message: string) => void
}

export interface ZcodeConnector {
  handle(input: ZcodeHookInput): void
  status(): ZcodeConnectorStatus
  reset(): void
  dispose(): void
}

const SUCCESS_IDLE_MS = 60_000
const WAITING_IDLE_MS = 600_000
const DISPOSE_MS = 1_800_000

/** Tool name fabricated per pre-tool class — chosen so normalizeSessionEvent's classifyTool lands on the intended toolKind ('edit'/'command'/'other'). */
const TOOL_NAME_BY_KIND: Record<string, string> = {
  'pre-tool-edit': 'edit',
  'pre-tool-command': 'bash',
  'pre-tool-other': 'read',
}

/** Hook kind → ledger state: the thinking/working/waiting cadence the HUD displays. */
const LEDGER_STATE_BY_KIND: Record<ZcodeHookKind, HookLedgerState> = {
  'session-start': 'idle',
  'user-prompt-submit': 'thinking',
  'pre-tool-edit': 'working',
  'pre-tool-command': 'working',
  'pre-tool-other': 'working',
  'post-tool': 'thinking',
  'permission-request': 'waiting',
  stop: 'success',
}

/**
 * The state-changing emission for a kind (docs/06 §1 minus the turn/start
 * marker, which is visually redundant — both map to active/thinking).
 */
function emitZcodeVisual(relay: StateRelay, sessionId: string, kind: ZcodeHookKind, ts: number): void {
  switch (kind) {
    case 'session-start':
      relay.emitAgentStatus(sessionId, 'idle')
      break
    case 'user-prompt-submit':
      relay.emitSessionEvent(sessionId, envelope('assistant/chunk', ts, { chunk: { type: 'reasoning-delta' } }))
      break
    case 'pre-tool-edit':
    case 'pre-tool-command':
    case 'pre-tool-other':
      relay.emitSessionEvent(sessionId, envelope('tool/call', ts, { name: TOOL_NAME_BY_KIND[kind] }))
      break
    case 'post-tool':
      relay.emitSessionEvent(sessionId, envelope('tool/result', ts, {}))
      break
    case 'permission-request':
      relay.emitSessionEvent(sessionId, envelope('approval/asked', ts, {}))
      break
    case 'stop':
      relay.emitSessionEvent(sessionId, envelope('turn/end', ts, { reason: { kind: 'completed' } }))
      break
  }
}

const ZCODE_PROFILE: HookConnectorProfile<ZcodeHookKind> = {
  logTag: 'petween-zcode',
  kinds: ZCODE_HOOK_KINDS,
  focusKinds: FOCUS_KINDS,
  ledgerStateByKind: LEDGER_STATE_BY_KIND,
  turnStartKinds: new Set<ZcodeHookKind>(['user-prompt-submit']),
  statsTurnIdKinds: new Set<ZcodeHookKind>(['stop']),
  editKinds: new Set<ZcodeHookKind>(['pre-tool-edit']),
  toolNameByKind: TOOL_NAME_BY_KIND,
  emitVisual: emitZcodeVisual,
  turnStartEmitKinds: new Set<ZcodeHookKind>(['user-prompt-submit']),
  idleAfter: {
    'permission-request': { delayMs: WAITING_IDLE_MS, reason: 'permission stranded' },
    stop: { delayMs: SUCCESS_IDLE_MS, reason: 'turn ended' },
  },
  idleResetKind: 'session-start',
  disposeAfterMs: DISPOSE_MS,
}

export function createZcodeConnector(deps: ZcodeConnectorDeps): ZcodeConnector {
  return createHookConnector<ZcodeHookKind>(deps, ZCODE_PROFILE) as ZcodeConnector
}
