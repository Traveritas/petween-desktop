/**
 * connectors/codex-connector.ts — the OpenAI Codex CLI profile on the generic
 * hook connector engine (Phase 16, docs/08). Same kind vocabulary as the CC
 * profile (zcode kinds + session-end); the deltas live in codex-hooks.ts
 * (hooks.json delivery, Interrupt mapping) and the routes (turn_id payload).
 *
 * Spike facts (2026-09-20, codex-cli 0.154.0 + openai/codex source):
 * - Codex implemented a CC-compatible hooks engine (literally
 *   `ClaudeHooksEngine` in codex-rs/hooks); 12 lifecycle events incl. native
 *   SessionEnd / PermissionRequest / Interrupt; no Notification.
 * - `Interrupt` (user hit escape) maps onto `session-start` — the immediate
 *   idle baseline. Without it an aborted turn would leave the pet working
 *   until the 30min watchdog.
 */
import type { StateRelay } from '../state-relay'
import { createHookConnector, envelope, type HookConnector, type HookConnectorDeps, type HookConnectorProfile, type HookLedgerState, type HookPayload } from './hook-connector'

export type CodexHookKind =
  | 'session-start'
  | 'user-prompt-submit'
  | 'pre-tool-edit'
  | 'pre-tool-command'
  | 'pre-tool-other'
  | 'post-tool'
  | 'permission-request'
  | 'stop'
  | 'session-end'

export const CODEX_HOOK_KINDS: readonly CodexHookKind[] = [
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
const FOCUS_KINDS: ReadonlySet<CodexHookKind> = new Set(['session-start', 'user-prompt-submit'])

export type CodexHookPayload = HookPayload

export type CodexConnectorStatus = {
  sessionsSeen: number
  lastEventAt: number | null
  lastKind: CodexHookKind | null
  followTarget: string | null
}

export interface CodexConnector {
  handle(input: { kind: CodexHookKind; sessionId: string; payload?: CodexHookPayload }): void
  status(): CodexConnectorStatus
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

const LEDGER_STATE_BY_KIND: Record<CodexHookKind, HookLedgerState> = {
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

function emitCodexVisual(relay: StateRelay, sessionId: string, kind: CodexHookKind, ts: number): void {
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

const CODEX_PROFILE: HookConnectorProfile<CodexHookKind> = {
  logTag: 'petween-codex',
  kinds: CODEX_HOOK_KINDS,
  focusKinds: FOCUS_KINDS,
  ledgerStateByKind: LEDGER_STATE_BY_KIND,
  turnStartKinds: new Set<CodexHookKind>(['user-prompt-submit']),
  statsTurnIdKinds: new Set<CodexHookKind>(['stop']),
  editKinds: new Set<CodexHookKind>(['pre-tool-edit']),
  toolNameByKind: TOOL_NAME_BY_KIND,
  emitVisual: emitCodexVisual,
  turnStartEmitKinds: new Set<CodexHookKind>(['user-prompt-submit']),
  idleAfter: {
    'permission-request': { delayMs: WAITING_IDLE_MS, reason: 'permission stranded' },
    stop: { delayMs: SUCCESS_IDLE_MS, reason: 'turn ended' },
  },
  idleResetKind: 'session-start',
  disposeAfterMs: DISPOSE_MS,
  disposeKinds: new Set<CodexHookKind>(['session-end']),
}

export function createCodexConnector(deps: HookConnectorDeps<CodexHookKind>): CodexConnector {
  return createHookConnector<CodexHookKind>(deps, CODEX_PROFILE) as CodexConnector
}
