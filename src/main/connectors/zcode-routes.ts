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
import { ZCODE_HOOK_KINDS, type ZcodeConnectorStatus, type ZcodeHookKind } from './zcode-connector'

export interface ZcodeConnectorRoutesDeps {
  /** False when the connector is disabled in settings — events are dropped. */
  isEnabled(): boolean
  onHookEvent(input: { kind: ZcodeHookKind; sessionId: string }): void
  /** Async: the hooksInstalled flag reads the zcode config file. */
  connectorStatus(): Promise<ZcodeConnectorStatus & { enabled: boolean; hooksInstalled: boolean }>
  installHooks(): Promise<void>
  uninstallHooks(): Promise<void>
}

const SESSION_MAX_CHARS = 200

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** The same write fence desktop-routes.ts implements (its rationale applies verbatim). */
function rejectsCrossOriginWrite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site === 'cross-site') return true
  const origin = req.headers.origin
  if (origin !== undefined) {
    if (typeof origin !== 'string' || typeof req.headers.host !== 'string') return true
    try {
      return new URL(origin).host !== req.headers.host
    } catch {
      return true
    }
  }
  return false
}

function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let overflowed = false
    req.on('error', reject)
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limitBytes) {
        if (overflowed) return
        overflowed = true
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!overflowed) resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
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
    void readBody(req, 4 * 1024).then(
      (body) => {
        const sessionId = new URLSearchParams(body).get('session') ?? ''
        if (kind === null || !(ZCODE_HOOK_KINDS as readonly string[]).includes(kind)) {
          sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: `unknown event kind ${JSON.stringify(kind)}` } })
          return
        }
        if (sessionId.length < 1 || sessionId.length > SESSION_MAX_CHARS || !/^[\w.-]+$/.test(sessionId)) {
          sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'invalid session id' } })
          return
        }
        if (deps.isEnabled()) deps.onHookEvent({ kind: kind as ZcodeHookKind, sessionId })
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
