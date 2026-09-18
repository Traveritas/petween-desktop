/**
 * stats routes: the HUD poll (GET only, since-passthrough, 405 otherwise).
 * Real HTTP over the route table, same pattern as zcode-routes.test.ts.
 */
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouteTable } from '../../src/main/routes-host'
import { registerStatsRoutes, STATS_PATH } from '../../src/main/connectors/stats-routes'

let server: Server
let base: string
let dispose: () => void

const snapshot = vi.fn()

beforeEach(async () => {
  snapshot.mockReset()
  const table = createRouteTable()
  dispose = registerStatsRoutes(table.host, { snapshot })
  server = createServer(table.handleRequest)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
})

describe('GET /api/petween-desktop/stats', () => {
  it('serves the snapshot json with no-store', async () => {
    snapshot.mockReturnValueOnce({ cursor: 7, focusedSessionId: 's1', sessions: {}, events: [] })
    const res = await fetch(base + STATS_PATH)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ cursor: 7, focusedSessionId: 's1', sessions: {}, events: [] })
  })

  it('passes a positive since through, ignores junk', async () => {
    snapshot.mockReturnValue({ cursor: 0, focusedSessionId: null, sessions: {}, events: [] })
    await fetch(`${base}${STATS_PATH}?since=42`)
    expect(snapshot).toHaveBeenLastCalledWith(42)
    await fetch(`${base}${STATS_PATH}?since=abc`)
    expect(snapshot).toHaveBeenLastCalledWith(0)
  })

  it('rejects non-GET', async () => {
    const res = await fetch(base + STATS_PATH, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})
