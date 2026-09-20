/**
 * connectors/cc-connector.ts — the Claude Code profile on the generic hook
 * connector engine (Phase 15, docs/07): the CC event vocabulary and its
 * mapping. Everything else (sessions, watchdogs, follow mode, stats
 * recording, StateRelay envelopes) is the shared engine.
 *
 * Differences from the zcode profile (docs/07 §3):
 * - `session-end` (CC SessionEnd): the session self-reports its end, so the
 *   engine disposes it immediately — no 30min-silence guess for a clean
 *   exit (the watchdog still covers crashed clients).
 * - PermissionRequest maps onto `permission-request` (waiting visual +
 *   stranded-approval decay). Notification is deliberately NOT registered
 *   (v0.6.3): its post-turn "waiting for your input" idle nudge polluted the
 *   success face with a phantom waiting face.
 * - No legacy payload-less hook generation: CC bodies are always stdin JSON
 *   with prompt_id (the turn id) and tool_name/tool_input on tool events.
 */
import type { StateRelay } from '../state-relay'
import { createHookConnector, envelope, type HookConnector, type HookConnectorDeps, type HookConnectorProfile, type HookLedgerState, type HookPayload } from './hook-connector'

export type CcHookKind =
  | 'session-start'
  | 'user-prompt-submit'
  | 'pre-tool-edit'
  | 'pre-tool-command'
  | 'pre-tool-other'
  | 'post-tool'
  | 'permission-request'
  | 'stop'
  | 'session-end'

export const CC_HOOK_KINDS: readonly CcHookKind[] = [
  'session-start',
  'user-prompt-submit',
  'pre-tool-edit',
  'pre-tool-command',
  'pre-tool-other',
  'post-tool',
  'permission-request',
  'stop',
  'session-end',
]

/** Events that only fire because the user acted on that session's window. */
const FOCUS_KINDS: ReadonlySet<CcHookKind> = new Set(['session-start', 'user-prompt-submit'])

export type CcHookPayload = HookPayload

export type CcConnectorStatus = {
  sessionsSeen: number
  lastEventAt: number | null
  lastKind: CcHookKind | null
  followTarget: string | null
}

export interface CcConnector {
  handle(input: { kind: CcHookKind; sessionId: string; payload?: CcHookPayload }): void
  retireFollowTarget(): void
  status(): CcConnectorStatus
  reset(): void
  dispose(): void
}

const SUCCESS_IDLE_MS = 60_000
const WAITING_IDLE_MS = 600_000
/** Crashed-client backstop — a clean exit reports SessionEnd long before this. */
const DISPOSE_MS = 1_800_000

/** Tool name fabricated per pre-tool class — chosen so classifyTool lands on the intended toolKind. */
const TOOL_NAME_BY_KIND: Record<string, string> = {
  'pre-tool-edit': 'edit',
  'pre-tool-command': 'bash',
  'pre-tool-other': 'read',
}

const LEDGER_STATE_BY_KIND: Record<CcHookKind, HookLedgerState> = {
  'session-start': 'idle',
  'user-prompt-submit': 'thinking',
  'pre-tool-edit': 'working',
  'pre-tool-command': 'working',
  'pre-tool-other': 'working',
  'post-tool': 'thinking',
  'permission-request': 'waiting',
  stop: 'success',
  'session-end': 'idle',
}

function emitCcVisual(relay: StateRelay, sessionId: string, kind: CcHookKind, ts: number): void {
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
    // session-end never emits a visual — the engine disposes the session.
    case 'session-end':
      break
  }
}

const CC_PROFILE: HookConnectorProfile<CcHookKind> = {
  logTag: 'petween-cc',
  kinds: CC_HOOK_KINDS,
  focusKinds: FOCUS_KINDS,
  ledgerStateByKind: LEDGER_STATE_BY_KIND,
  turnStartKinds: new Set<CcHookKind>(['user-prompt-submit']),
  statsTurnIdKinds: new Set<CcHookKind>(['stop']),
  editKinds: new Set<CcHookKind>(['pre-tool-edit']),
  emitVisual: emitCcVisual,
  turnStartEmitKinds: new Set<CcHookKind>(['user-prompt-submit']),
  idleAfter: {
    'permission-request': { delayMs: WAITING_IDLE_MS, reason: 'permission stranded' },
    stop: { delayMs: SUCCESS_IDLE_MS, reason: 'turn ended' },
  },
  idleResetKind: 'session-start',
  disposeAfterMs: DISPOSE_MS,
  disposeKinds: new Set<CcHookKind>(['session-end']),
}

export function createCcConnector(deps: HookConnectorDeps<CcHookKind>): CcConnector {
  return createHookConnector<CcHookKind>(deps, CC_PROFILE) as CcConnector
}
