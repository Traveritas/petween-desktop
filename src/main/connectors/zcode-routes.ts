/**
 * connectors/zcode-routes.ts — the four /api/petween-desktop/connector/zcode/*
 * endpoints (docs/06 §5): the hook event sink (curl POSTs land here), status
 * for the settings card, and install/uninstall for the zcode config write.
 *
 * Same shape as desktop-routes.ts: exact-path table registration, the
 * cross-origin write fence on every mutating route (hook curls carry no
 * Origin header — local processes pass, browser pages do not), and Electron
 * stays out entirely.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ZCODE_HOOK_KINDS, type ZcodeConnectorStatus, type ZcodeHookKind, type ZcodeHookPayload } from './zcode-connector'
import { readBody, rejectsCrossOriginWrite, sendJson } from './route-helpers'

export interface ZcodeConnectorRoutesDeps {
  /** False when the connector is disabled in settings — events are dropped. */
  isEnabled(): boolean
  onHookEvent(input: { kind: ZcodeHookKind; sessionId: string; payload?: ZcodeHookPayload }): void
  /** Async: the hooksInstalled flag reads the zcode config file. */
  connectorStatus(): Promise<ZcodeConnectorStatus & { enabled: boolean; hooksInstalled: boolean }>
  installHooks(): Promise<void>
  uninstallHooks(): Promise<void>
}

const SESSION_MAX_CHARS = 200

/**
 * Phase 10 bodies are the hook's stdin JSON (Write/Edit payloads can carry a
 * whole file); the legacy scalar body stays tiny. 1 MB bounds a runaway
 * payload while covering any realistic file content (docs/06 §8).
 */
const EVENT_BODY_LIMIT_BYTES = 1024 * 1024

/**
 * Both body generations (docs/06 §8): Phase 10 hooks POST the stdin JSON
 * verbatim; legacy hooks POST `session=<id>`. A JSON body may carry a
 * trailing `&session=...` (curl concatenates when a transitional install
 * mixes --data-urlencode with --data-binary) — strip it before parsing.
 * Returns null session when nothing usable is found (→ 400 upstream).
 */
export function parseHookBody(body: string): { sessionId: string; payload?: ZcodeHookPayload } {
  const trimmed = body.trimStart()
  if (trimmed.startsWith('{')) {
    const jsonStart = body.indexOf('{')
    const stripped = body.replace(/&session=[^&]*$/, '')
    try {
      const parsed = JSON.parse(stripped.slice(jsonStart)) as Record<string, unknown>
      const sessionId = pickString(parsed.session_id, parsed.sessionId)
      if (sessionId === null) return { sessionId: '' }
      const payload: ZcodeHookPayload = {}
      const toolName = pickString(parsed.tool_name, parsed.toolName)
      const turnId = pickString(parsed.turnId)
      if (toolName !== null) payload.toolName = toolName
      if (turnId !== null) payload.turnId = turnId
      if (parsed.tool_input !== undefined) payload.toolInput = parsed.tool_input
      else if (parsed.toolInput !== undefined) payload.toolInput = parsed.toolInput
      const ts = parsed.timestamp
      if (typeof ts === 'string') {
        const at = Date.parse(ts)
        if (Number.isFinite(at)) payload.at = at
      } else if (typeof ts === 'number' && Number.isFinite(ts)) {
        payload.at = ts
      }
      return { sessionId, payload }
    } catch {
      return { sessionId: '' }
    }
  }
  return { sessionId: new URLSearchParams(body).get('session') ?? '' }
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

export function registerZcodeConnectorRoutes(
  host: { webServer: { register(route: WebRoute): () => void } },
  deps: ZcodeConnectorRoutesDeps,
): () => void {
  const disposers: Array<() => void> = []
  const exact = (
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>,
  ): void => {
    disposers.push(
      host.webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          res.on('error', () => {})
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          void Promise.resolve(handler(req, res, url)).catch((error: unknown) => {
            console.error('[petween-zcode] route handler threw', error)
            sendJson(res, 500, { error: { code: 'INTERNAL', message: 'handler failed' } })
          })
        },
      }),
    )
  }

  const EVENT_PATH = '/api/petween-desktop/connector/zcode/event'
  const STATUS_PATH = '/api/petween-desktop/connector/zcode/status'
  const INSTALL_PATH = '/api/petween-desktop/connector/zcode/install'
  const UNINSTALL_PATH = '/api/petween-desktop/connector/zcode/uninstall'

  // The hook sink. Always answers 204 fast — hooks run inline in zcode, so
  // the response must never wait on anything.
  exact(EVENT_PATH, (req, res, url) => {
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
        const { sessionId, payload } = parseHookBody(body)
        if (kind === null || !(ZCODE_HOOK_KINDS as readonly string[]).includes(kind)) {
          sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: `unknown event kind ${JSON.stringify(kind)}` } })
          return
        }
        if (sessionId.length < 1 || sessionId.length > SESSION_MAX_CHARS || !/^[\w.-]+$/.test(sessionId)) {
          sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'invalid session id' } })
          return
        }
        if (deps.isEnabled()) deps.onHookEvent({ kind: kind as ZcodeHookKind, sessionId, ...(payload === undefined ? {} : { payload }) })
        res.writeHead(204)
        res.end()
      },
      () => sendJson(res, 413, { error: { code: 'BODY_TOO_LARGE', message: 'body too large' } }),
    )
  })

  exact(STATUS_PATH, async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'expected GET' } })
      return
    }
    sendJson(res, 200, await deps.connectorStatus())
  })

  const action = (
    path: string,
    run: () => Promise<void>,
    done: (res: ServerResponse) => void,
  ): void => {
    exact(path, (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'expected POST' } })
        return
      }
      if (rejectsCrossOriginWrite(req)) {
        sendJson(res, 403, { error: { code: 'CROSS_ORIGIN', message: 'cross-origin writes are rejected' } })
        return
      }
      void run().then(
        () => done(res),
        (error: unknown) => {
          console.error('[petween-zcode] hooks action failed', error)
          sendJson(res, 500, { error: { code: 'INSTALL_FAILED', message: String(error instanceof Error ? error.message : error) } })
        },
      )
    })
  }

  action(INSTALL_PATH, deps.installHooks, (res) => sendJson(res, 200, { ok: true }))
  action(UNINSTALL_PATH, deps.uninstallHooks, (res) => sendJson(res, 200, { ok: true }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
