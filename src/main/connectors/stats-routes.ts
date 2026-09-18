/**
 * connectors/stats-routes.ts — the read-only stats poll for the HUD companion
 * (docs/05 Phase 10): GET /api/petween-desktop/stats?since=<seq>. Pure Node,
 * same exact-path table pattern as zcode-routes; no write fence needed (GET,
 * counts only, no content ever crosses this endpoint).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { StatsSnapshot } from './stats-ledger'

export const STATS_PATH = '/api/petween-desktop/stats'

export interface StatsRoutesDeps {
  snapshot(since?: number): StatsSnapshot
}

export function registerStatsRoutes(
  host: { webServer: { register(route: WebRoute): () => void } },
  deps: StatsRoutesDeps,
): () => void {
  const dispose = host.webServer.register({
    kind: 'exact',
    path: STATS_PATH,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      res.on('error', () => {})
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'expected GET' } }))
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const rawSince = Number(url.searchParams.get('since'))
      const since = Number.isFinite(rawSince) && rawSince > 0 ? rawSince : 0
      const body = JSON.stringify(deps.snapshot(since))
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      })
      res.end(body)
    },
  })
  return () => dispose()
}
