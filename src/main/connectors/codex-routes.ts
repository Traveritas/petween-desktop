/**
 * connectors/codex-routes.ts — the four /api/petween-desktop/connector/codex/*
 * endpoints (Phase 16, docs/08 §4): the hook event sink (Codex hook curls
 * POST here), status for the settings card, and install/uninstall for the
 * ~/.codex/hooks.json write. Same shape as cc-routes.ts.
 *
 * Codex stdin payloads (spike-verified against openai/codex
 * codex-rs/hooks/src/schema.rs, 0.154.0): snake_case common fields
 * `session_id` / `turn_id` / `transcript_path` (nullable) / `cwd` /
 * `hook_event_name` / `model` / `permission_mode`; tool events add
 * `tool_name` / `tool_input`. `turn_id` is the ledger turnId (Codex's own
 * extension — better than CC's prompt_id derivation).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, registerExactRoutes, rejectsCrossOriginWrite, sendJson } from './route-helpers'
import { CODEX_HOOK_KINDS, type CodexConnectorStatus, type CodexHookKind, type CodexHookPayload } from './codex-connector'

export interface CodexConnectorRoutesDeps {
  /** False when the connector is disabled in settings — events are dropped. */
  isEnabled(): boolean
  onHookEvent(input: { kind: CodexHookKind; sessionId: string; payload?: CodexHookPayload }): void
  /** Async: the hooksInstalled flag reads hooks.json. */
  connectorStatus(): Promise<CodexConnectorStatus & { enabled: boolean; hooksInstalled: boolean }>
  installHooks(): Promise<void>
  uninstallHooks(): Promise<void>
}

const SESSION_MAX_CHARS = 200

/** Codex stdin JSON carries tool_input with whole files — same bound as the siblings. */
const EVENT_BODY_LIMIT_BYTES = 1024 * 1024

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/** Codex bodies are always the hook's stdin JSON (snake_case per schema.rs). */
export function parseCodexHookBody(body: string): { sessionId: string; payload?: CodexHookPayload } {
  const trimmed = body.trimStart()
  if (!trimmed.startsWith('{')) return { sessionId: '' }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const sessionId = pickString(parsed.session_id, parsed.sessionId)
    if (sessionId === null) return { sessionId: '' }
    const payload: CodexHookPayload = {}
    const toolName = pickString(parsed.tool_name, parsed.toolName)
    const turnId = pickString(parsed.turn_id, parsed.turnId)
    const transcriptPath = pickString(parsed.transcript_path, parsed.transcriptPath)
    if (toolName !== null) payload.toolName = toolName
    if (turnId !== null) payload.turnId = turnId
    if (transcriptPath !== null) payload.transcriptPath = transcriptPath
    if (parsed.tool_input !== undefined) payload.toolInput = parsed.tool_input
    else if (parsed.toolInput !== undefined) payload.toolInput = parsed.toolInput
    return { sessionId, payload }
  } catch {
    return { sessionId: '' }
  }
}

export function registerCodexConnectorRoutes(
  host: { webServer: { register(route: import('@deepseek-ai/dsh-host-webserver').WebRoute): () => void } },
  deps: CodexConnectorRoutesDeps,
): () => void {
  const EVENT_PATH = '/api/petween-desktop/connector/codex/event'
  const STATUS_PATH = '/api/petween-desktop/connector/codex/status'
  const INSTALL_PATH = '/api/petween-desktop/connector/codex/install'
  const UNINSTALL_PATH = '/api/petween-desktop/connector/codex/uninstall'

  const action = (path: string, run: () => Promise<void>): {
    path: string
    logTag: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  } => ({
    path,
    logTag: 'petween-codex',
    handler: (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'expected POST' } })
        return
      }
      if (rejectsCrossOriginWrite(req)) {
        sendJson(res, 403, { error: { code: 'CROSS_ORIGIN', message: 'cross-origin writes are rejected' } })
        return
      }
      void run().then(
        () => sendJson(res, 200, { ok: true }),
        (error: unknown) => {
          console.error('[petween-codex] hooks action failed', error)
          sendJson(res, 500, { error: { code: 'INSTALL_FAILED', message: String(error instanceof Error ? error.message : error) } })
        },
      )
    },
  })

  return registerExactRoutes(host, [
    // The hook sink. Always answers 204 fast — hooks run inline in Codex.
    {
      path: EVENT_PATH,
      logTag: 'petween-codex',
      handler: (req, res, url) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'expected POST' } })
          return
        }
        if (rejectsCrossOriginWrite(req)) {
          sendJson(res, 403, { error: { code: 'CROSS_ORIGIN', message: 'cross-origin writes are rejected' } })
          return
        }
        const kind = url.searchParams.get('e')
        void readBody(req, EVENT_BODY_LIMIT_BYTES).then(
          (body) => {
            const { sessionId, payload } = parseCodexHookBody(body)
            if (kind === null || !(CODEX_HOOK_KINDS as readonly string[]).includes(kind)) {
              sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: `unknown event kind ${JSON.stringify(kind)}` } })
              return
            }
            if (sessionId.length < 1 || sessionId.length > SESSION_MAX_CHARS || !/^[\w.-]+$/.test(sessionId)) {
              sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'invalid session id' } })
              return
            }
            if (deps.isEnabled()) deps.onHookEvent({ kind: kind as CodexHookKind, sessionId, ...(payload === undefined ? {} : { payload }) })
            res.writeHead(204)
            res.end()
          },
          () => sendJson(res, 413, { error: { code: 'BODY_TOO_LARGE', message: 'body too large' } }),
        )
      },
    },
    {
      path: STATUS_PATH,
      logTag: 'petween-codex',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'expected GET' } })
          return
        }
        sendJson(res, 200, await deps.connectorStatus())
      },
    },
    action(INSTALL_PATH, deps.installHooks),
    action(UNINSTALL_PATH, deps.uninstallHooks),
  ])
}
