/**
 * connectors/cc-routes.ts — the four /api/petween-desktop/connector/cc/*
 * endpoints (Phase 15, docs/07 §4): the hook event sink (CC hook curls POST
 * here), status for the settings card, and install/uninstall for the
 * ~/.claude/settings.json write. Same shape as zcode-routes.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, registerExactRoutes, rejectsCrossOriginWrite, sendJson } from './route-helpers'
import { CC_HOOK_KINDS, type CcConnectorStatus, type CcHookKind, type CcHookPayload } from './cc-connector'

export interface CcConnectorRoutesDeps {
  /** False when the connector is disabled in settings — events are dropped. */
  isEnabled(): boolean
  onHookEvent(input: { kind: CcHookKind; sessionId: string; payload?: CcHookPayload }): void
  /** Async: the hooksInstalled flag reads settings.json. */
  connectorStatus(): Promise<CcConnectorStatus & { enabled: boolean; hooksInstalled: boolean }>
  installHooks(): Promise<void>
  uninstallHooks(): Promise<void>
}

const SESSION_MAX_CHARS = 200

/** CC stdin JSON carries tool_input with whole files — same bound as zcode. */
const EVENT_BODY_LIMIT_BYTES = 1024 * 1024

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * CC bodies are always the hook's stdin JSON (there is no legacy generation):
 * common fields session_id / prompt_id / transcript_path / cwd, tool events
 * add tool_name / tool_input. prompt_id is the per-prompt turn id.
 */
export function parseCcHookBody(body: string): { sessionId: string; payload?: CcHookPayload } {
  const trimmed = body.trimStart()
  if (!trimmed.startsWith('{')) return { sessionId: '' }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const sessionId = pickString(parsed.session_id, parsed.sessionId)
    if (sessionId === null) return { sessionId: '' }
    const payload: CcHookPayload = {}
    const toolName = pickString(parsed.tool_name, parsed.toolName)
    const turnId = pickString(parsed.prompt_id, parsed.promptId)
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

export function registerCcConnectorRoutes(
  host: { webServer: { register(route: import('@deepseek-ai/dsh-host-webserver').WebRoute): () => void } },
  deps: CcConnectorRoutesDeps,
): () => void {
  const EVENT_PATH = '/api/petween-desktop/connector/cc/event'
  const STATUS_PATH = '/api/petween-desktop/connector/cc/status'
  const INSTALL_PATH = '/api/petween-desktop/connector/cc/install'
  const UNINSTALL_PATH = '/api/petween-desktop/connector/cc/uninstall'

  const action = (
    path: string,
    run: () => Promise<void>,
  ): { path: string; logTag: string; handler: (req: IncomingMessage, res: ServerResponse) => void } => ({
    path,
    logTag: 'petween-cc',
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
          console.error('[petween-cc] hooks action failed', error)
          sendJson(res, 500, { error: { code: 'INSTALL_FAILED', message: String(error instanceof Error ? error.message : error) } })
        },
      )
    },
  })

  return registerExactRoutes(host, [
    // The hook sink. Always answers 204 fast — hooks run inline in CC, so
    // the response must never wait on anything.
    {
      path: EVENT_PATH,
      logTag: 'petween-cc',
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
            const { sessionId, payload } = parseCcHookBody(body)
            if (kind === null || !(CC_HOOK_KINDS as readonly string[]).includes(kind)) {
              sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: `unknown event kind ${JSON.stringify(kind)}` } })
              return
            }
            if (sessionId.length < 1 || sessionId.length > SESSION_MAX_CHARS || !/^[\w.-]+$/.test(sessionId)) {
              sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'invalid session id' } })
              return
            }
            if (deps.isEnabled()) deps.onHookEvent({ kind: kind as CcHookKind, sessionId, ...(payload === undefined ? {} : { payload }) })
            res.writeHead(204)
            res.end()
          },
          () => sendJson(res, 413, { error: { code: 'BODY_TOO_LARGE', message: 'body too large' } }),
        )
      },
    },
    {
      path: STATUS_PATH,
      logTag: 'petween-cc',
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
