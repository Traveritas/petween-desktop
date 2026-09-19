/**
 * connectors/dialogue-routes.ts — GET /api/petween-desktop/dialogue?session=<id>
 * (Phase 10 second batch): on-demand reply preview for the dialogue bubble.
 * Read-only, no persistence, content already truncated at the source. Same
 * exact-path table pattern as stats-routes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DialogueSource } from './dialogue-source'

export const DIALOGUE_PATH = '/api/petween-desktop/dialogue'

export function registerDialogueRoutes(
  host: { webServer: { register(route: WebRoute): () => void } },
  deps: { source: DialogueSource },
): () => void {
  const dispose = host.webServer.register({
    kind: 'exact',
    path: DIALOGUE_PATH,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      res.on('error', () => {})
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'expected GET' } }))
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const sessionId = url.searchParams.get('session') ?? ''
      void deps.source
        .latestReply(sessionId)
        .then((preview) => {
          if (res.destroyed || res.writableEnded) return
          if (preview === null) {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: { code: 'NO_REPLY', message: 'no completed reply' } }))
            return
          }
          const body = JSON.stringify(preview)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'cache-control': 'no-store',
          })
          res.end(body)
        })
        .catch(() => {
          if (res.destroyed || res.writableEnded) return
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'dialogue read failed' } }))
        })
    },
  })
  return () => dispose()
}
