/**
 * routes-host.ts — the RoutesHost adapter (docs/02 §2): a route table plus a
 * node:http dispatcher mirroring the DSH webServer semantics — exact table
 * first, then the longest matching prefix. Reference implementation:
 * vendor/petween/tests/host/routes.test.ts:78-108. Pure Node, no Electron.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

export interface RouteTable {
  /** The RoutesHost-shaped facade petween's register* functions expect. */
  readonly host: {
    webServer: {
      register(route: WebRoute): () => void
    }
  }
  /** Dispatch one request; answers 404 itself when nothing matches. */
  handleRequest(req: IncomingMessage, res: ServerResponse): void
  /** Registered routes in registration order (test introspection). */
  list(): readonly WebRoute[]
  /**
   * Restrict dispatch to these exact Host header values (lowercased
   * `host:port`). The DNS-rebinding fence (v0.4.0 review): a rebound page
   * requests http://attacker.com:<port>/ which carries the attacker's Host,
   * so Origin↔Host relative checks pass but this exact match fails.
   * Unset = allow all (route-table unit tests; the local server always sets
   * it right after listen, before the event loop can turn).
   */
  setAllowedHosts(hosts: ReadonlySet<string>): void
}

function parsePathname(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    return '/'
  }
}

export function createRouteTable(): RouteTable {
  const routes: WebRoute[] = []
  let allowedHosts: ReadonlySet<string> | null = null

  const register = (route: WebRoute): (() => void) => {
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index !== -1) routes.splice(index, 1)
    }
  }

  return {
    host: { webServer: { register } },
    setAllowedHosts(hosts) {
      allowedHosts = new Set([...hosts].map((host) => host.toLowerCase()))
    },
    handleRequest(req, res) {
      if (allowedHosts !== null && !allowedHosts.has((req.headers.host ?? '').toLowerCase())) {
        // Never disclose the route table to a foreign-origin requester —
        // 403 before any handler runs, GET included.
        res
          .writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          .end(JSON.stringify({ error: 'FORBIDDEN_HOST' }))
        return
      }
      const pathname = parsePathname(req.url)
      const route =
        routes.find((candidate) => candidate.kind === 'exact' && candidate.path === pathname) ??
        routes
          .filter(
            (candidate) =>
              candidate.kind === 'prefix' &&
              (pathname === candidate.path || pathname.startsWith(`${candidate.path}/`)),
          )
          .sort((a, b) => b.path.length - a.path.length)[0]
      if (route === undefined) {
        res.writeHead(404).end()
        return
      }
      try {
        void route.handler(req, res)
      } catch (error) {
        // A throwing handler must not escape into an uncaught exception —
        // vendor routes wrap themselves; this covers the shell's own.
        console.error('[petween-desktop] route handler threw', error)
        if (!res.headersSent) res.writeHead(500).end()
      }
    },
    list: () => routes,
  }
}
