/**
 * overlay-static.ts — serves the electron-vite renderer build (out/renderer)
 * from the local-server so the prod overlay window can stay same-origin with
 * the petween API (docs/02 §1: both windows load http://127.0.0.1:<port>/...).
 *
 * Routes registered:
 * - exact /overlay.html, /overlay, /overlay/index.html → the overlay page
 * - prefix /assets → hashed vite chunks (js/css/images), traversal-guarded
 *
 * Pure Node, no Electron.
 */
import { readFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

function send(res: ServerResponse, status: number, contentType: string, data: Buffer | string): void {
  const body = typeof data === 'string' ? Buffer.from(data) : data
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function sendNotFound(res: ServerResponse): void {
  send(res, 404, 'application/json; charset=utf-8', '{"error":{"code":"NOT_FOUND","message":"no such file"}}')
}

async function serveFile(res: ServerResponse, rootDir: string, relative: string): Promise<void> {
  const root = resolve(rootDir)
  const absolute = resolve(join(root, relative))
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    sendNotFound(res) // traversal attempt
    return
  }
  try {
    const data = await readFile(absolute)
    send(res, 200, MIME[extname(absolute).toLowerCase()] ?? 'application/octet-stream', data)
  } catch {
    sendNotFound(res)
  }
}

export function registerOverlayStatic(
  host: { webServer: { register(route: WebRoute): () => void } },
  rendererDistDir: string,
): () => void {
  const page = (relative: string) => (req: IncomingMessage, res: ServerResponse): void => {
    void serveFile(res, rendererDistDir, relative)
  }
  const overlayPage = page(join('overlay', 'index.html'))
  const settingsPage = page(join('settings', 'index.html'))
  const disposers = [
    host.webServer.register({ kind: 'exact', path: '/overlay.html', handler: overlayPage }),
    host.webServer.register({ kind: 'exact', path: '/overlay', handler: overlayPage }),
    host.webServer.register({ kind: 'exact', path: '/overlay/index.html', handler: overlayPage }),
    host.webServer.register({ kind: 'exact', path: '/settings.html', handler: settingsPage }),
    host.webServer.register({ kind: 'exact', path: '/settings', handler: settingsPage }),
    host.webServer.register({ kind: 'exact', path: '/settings/index.html', handler: settingsPage }),
    host.webServer.register({
      kind: 'prefix',
      path: '/assets',
      handler: (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        void serveFile(res, join(rendererDistDir, 'assets'), pathname.slice('/assets/'.length))
      },
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
