/**
 * connectors/dialogue-routes.ts — GET /api/petween-desktop/dialogue?session=<id>
 * (Phase 10 second batch): on-demand reply preview for the dialogue bubble.
 * Read-only, no persistence, content already truncated at each source.
 * Multi-source since the Phase 15 unbinding: sources are probed in order
 * and the first non-null preview wins (session ids never collide across
 * CLIs in practice — zcode `sess_*` vs CC UUIDs — so the order is not
 * load-bearing). Same exact-path table pattern as stats-routes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DialogueSource, DialoguePreview } from './dialogue-source'

export const DIALOGUE_PATH = '/api/petween-desktop/dialogue'

export function registerDialogueRoutes(
  host: { webServer: { register(route: WebRoute): () => void } },
  deps: { sources: readonly DialogueSource[] },
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
      void (async () => {
        let preview: DialoguePreview | null = null
        for (const source of deps.sources) {
          preview = await source.latestReply(sessionId)
          if (preview !== null) break
        }
        return preview
      })().then(
        (preview) => {
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
        },
        () => {
          if (res.destroyed || res.writableEnded) return
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'dialogue read failed' } }))
        },
      )
    },
  })
  return () => dispose()
}

