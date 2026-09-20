/**
 * dialogue routes: the reply-preview read channel (GET only, no-store,
 * NO_REPLY vs INTERNAL vs 200 — the full-channel test gap the v0.4.0 review
 * flagged: this is the only content-level endpoint in the app). Real HTTP
 * over the route table, same pattern as stats-routes.test.ts.
 */
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouteTable } from '../../src/main/routes-host'
import { registerDialogueRoutes, DIALOGUE_PATH } from '../../src/main/connectors/dialogue-routes'
import type { DialogueSource } from '../../src/main/connectors/dialogue-source'

let server: Server
let base: string
let dispose: () => void

const latestReply = vi.fn()
const fallbackReply = vi.fn()

beforeEach(async () => {
  latestReply.mockReset()
  fallbackReply.mockReset()
  const table = createRouteTable()
  const primary = { latestReply } as unknown as DialogueSource
  const fallback = { latestReply: fallbackReply } as unknown as DialogueSource
  dispose = registerDialogueRoutes(table.host, { sources: [primary, fallback] })
  server = createServer(table.handleRequest)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterEach(async () => {
  dispose()
  await new Promise((resolve) => server.close(resolve))
})

describe(`GET ${DIALOGUE_PATH}`, () => {
  it('serves the first non-null preview with no-store', async () => {
    latestReply.mockResolvedValueOnce(null)
    fallbackReply.mockResolvedValueOnce({ sessionId: 's1', turnId: 't1', text: 'hi', at: 5 })
    const res = await fetch(`${base}${DIALOGUE_PATH}?session=s1`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ sessionId: 's1', turnId: 't1', text: 'hi', at: 5 })
    expect(latestReply).toHaveBeenCalledWith('s1')
    expect(fallbackReply).toHaveBeenCalledWith('s1')
  })

  it('stops probing at the first source that answers', async () => {
    latestReply.mockResolvedValueOnce({ sessionId: 's1', turnId: 't1', text: 'primary', at: 5 })
    const res = await fetch(`${base}${DIALOGUE_PATH}?session=s1`)
    expect(await res.json()).toMatchObject({ text: 'primary' })
    expect(fallbackReply).not.toHaveBeenCalled()
  })

  it('answers 404 NO_REPLY when every source has nothing', async () => {
    latestReply.mockResolvedValueOnce(null)
    fallbackReply.mockResolvedValueOnce(null)
    const res = await fetch(`${base}${DIALOGUE_PATH}?session=s1`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NO_REPLY')
  })

  it('answers 500 INTERNAL when every source rejects', async () => {
    latestReply.mockRejectedValueOnce(new Error('boom'))
    fallbackReply.mockRejectedValueOnce(new Error('bam'))
    const res = await fetch(`${base}${DIALOGUE_PATH}?session=s1`)
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL')
  })

  it('one broken source does not mask the others (phase-review fix)', async () => {
    latestReply.mockRejectedValueOnce(new Error('cc transcript exploded'))
    fallbackReply.mockResolvedValueOnce({ sessionId: 's1', turnId: 't1', text: 'from zcode', at: 5 })
    const res = await fetch(`${base}${DIALOGUE_PATH}?session=s1`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ text: 'from zcode' })
  })

  it('a rejecting source plus a clean NO_REPLY answers 404, not 500', async () => {
    latestReply.mockRejectedValueOnce(new Error('boom'))
    fallbackReply.mockResolvedValueOnce(null)
    const res = await fetch(`${base}${DIALOGUE_PATH}?session=s1`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NO_REPLY')
  })

  it('rejects non-GET', async () => {
    const res = await fetch(base + DIALOGUE_PATH, { method: 'POST' })
    expect(res.status).toBe(405)
    expect(latestReply).not.toHaveBeenCalled()
  })
})
