/**
 * desktop-routes.ts — the shell-owned settings API under
 * /api/petween-desktop/* (namespace does not collide with petween's
 * /api/petween — prefix matching is segment-based). Pure Node; every
 * Electron-facing capability is injected. The settings page talks ONLY to
 * these endpoints (no IPC), so it works identically in dev (vite proxy)
 * and prod (same origin).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DesktopSettingsStore } from './desktop-settings'

export interface DesktopStatus {
  dsh: { enabled: boolean; connected: boolean; detail?: string }
  appVersion: string
  dataRoot: string
  /** Origin the settings page should iframe the petween editor from. */
  serverOrigin: string
}

export interface DesktopRoutesDeps {
  settings: DesktopSettingsStore
  status(): DesktopStatus
  fixInteraction(): void
  /** Opens the standalone animator window (Phase 11); a shell-side capability. */
  openAnimator(): void
  getAutoLaunch(): boolean
  setAutoLaunch(enabled: boolean): void
  probeDsh(port: number): Promise<{ version: string } | null>
}

const BODY_LIMIT_BYTES = 64 * 1024

/**
 * The browser-page write fence both vendor route modules implement (petween
 * routes.ts rejectsCrossOriginWrite): a malicious webpage may land simple
 * no-preflight POSTs unless Sec-Fetch-Site/Origin say cross-site. Local
 * processes (no Origin header) stay allowed — that trust boundary is
 * documented in docs/05.
 */
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return // client aborted mid-flight
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let overflowed = false
    req.on('error', reject)
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        if (overflowed) return
        overflowed = true
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overflowed) return // already rejected
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
  })
}

export function registerDesktopRoutes(
  host: { webServer: { register(route: WebRoute): () => void } },
  deps: DesktopRoutesDeps,
): () => void {
  const disposers: Array<() => void> = []

  const exact = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): void => {
    disposers.push(
      host.webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          res.on('error', () => {}) // aborted client sockets must not crash the host
          void Promise.resolve(handler(req, res)).catch((error: unknown) => {
            console.error('[petween-desktop] desktop route handler threw', error)
            sendJson(res, 500, { error: { code: 'INTERNAL', message: 'handler failed' } })
          })
        },
      }),
    )
  }
  const fence = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method === 'GET' || req.method === 'HEAD') return false
    if (rejectsCrossOriginWrite(req)) {
      sendJson(res, 403, { error: { code: 'CROSS_ORIGIN', message: 'cross-origin writes are rejected' } })
      return true
    }
    return false
  }

  exact('/api/petween-desktop/settings', (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, { settings: deps.settings.get() })
      return
    }
    if (req.method === 'PUT') {
      if (fence(req, res)) return
      void readJsonBody(req).then(
        (patch) => sendJson(res, 200, { settings: deps.settings.update(patch) }),
        () => sendJson(res, 400, { error: { code: 'BAD_JSON', message: 'invalid JSON body' } }),
      )
      return
    }
    sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'expected GET or PUT' } })
  })

  exact('/api/petween-desktop/status', (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'expected GET' } })
      return
    }
    sendJson(res, 200, deps.status())
  })

  exact('/api/petween-desktop/autolaunch', (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, { enabled: deps.getAutoLaunch() })
      return
    }
    if (req.method === 'PUT') {
      if (fence(req, res)) return
      void readJsonBody(req).then(
        (body) => {
          const enabled = (body as { enabled?: unknown }).enabled
          if (typeof enabled !== 'boolean') {
            sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'expected { enabled: boolean }' } })
            return
          }
          deps.setAutoLaunch(enabled)
          sendJson(res, 200, { enabled: deps.getAutoLaunch() })
        },
        () => sendJson(res, 400, { error: { code: 'BAD_JSON', message: 'invalid JSON body' } }),
      )
      return
    }
    sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'expected GET or PUT' } })
  })

  exact('/api/petween-desktop/open-animator', (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'expected POST' } })
      return
    }
    if (fence(req, res)) return
    deps.openAnimator()
    sendJson(res, 200, { ok: true })
  })

  exact('/api/petween-desktop/fix-interaction', (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'expected POST' } })
      return
    }
    if (fence(req, res)) return
    deps.fixInteraction()
    sendJson(res, 200, { ok: true })
  })

  exact('/api/petween-desktop/dsh-test', (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'expected POST' } })
      return
    }
    if (fence(req, res)) return
    void readJsonBody(req).then(
      async (body) => {
        const port = (body as { port?: unknown }).port
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
          sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'expected { port: 1..65535 }' } })
          return
        }
        const found = await deps.probeDsh(port)
        sendJson(res, 200, { ok: found !== null, version: found?.version ?? null })
      },
      () => sendJson(res, 400, { error: { code: 'BAD_JSON', message: 'invalid JSON body' } }),
    )
  })

  return () => {
    for (const dispose of disposers) dispose()
  }
}
