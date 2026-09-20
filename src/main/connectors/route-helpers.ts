/**
 * connectors/route-helpers.ts — shared HTTP plumbing for connector route
 * modules (zcode-routes, cc-routes, future Codex): JSON responses, the
 * cross-origin write fence, bounded body reads, and exact-path registration
 * with the error wrapper. Extracted from zcode-routes.ts (v0.4.0 behaviour
 * unchanged) so the third connector does not copy it a third time.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * The write fence desktop-routes.ts implements (its rationale applies
 * verbatim): hook curls carry no Origin header — local processes pass,
 * browser pages do not.
 */
export function rejectsCrossOriginWrite(req: IncomingMessage): boolean {
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

export function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
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

/** Exact-path registration with the route-table error wrapper. */
export function registerExactRoutes(
  host: { webServer: { register(route: WebRoute): () => void } },
  routes: Array<{
    path: string
    logTag: string
    handler: (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>
  }>,
): () => void {
  const disposers: Array<() => void> = []
  for (const { path, logTag, handler } of routes) {
    disposers.push(
      host.webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          res.on('error', () => {})
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          void Promise.resolve(handler(req, res, url)).catch((error: unknown) => {
            console.error(`[${logTag}] route handler threw`, error)
            sendJson(res, 500, { error: { code: 'INTERNAL', message: 'handler failed' } })
          })
        },
      }),
    )
  }
  return () => {
    for (const dispose of disposers) dispose()
  }
}
