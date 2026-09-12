/**
 * Route-table dispatch semantics: exact-first, then longest matching prefix,
 * 404 when nothing matches, unregister removes the route (docs/02 §2 —
 * the adapter must behave like the DSH webServer the handlers were written
 * for; reference: petween tests/host/routes.test.ts:78-108).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createRouteTable } from '../../src/main/routes-host'

function makeReqRes(url: string): { req: IncomingMessage; res: ServerResponse; status: () => number | undefined; body: () => string } {
  const state = { status: undefined as number | undefined, body: '', ended: false }
  const req = { method: 'GET', url } as IncomingMessage
  const res = {
    writeHead(status: number) {
      state.status = status
      return res
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) state.body = String(chunk)
      state.ended = true
      return res
    },
  } as unknown as ServerResponse
  return { req, res, status: () => state.status, body: () => state.body }
}

describe('createRouteTable dispatch', () => {
  it('matches exact routes before prefixes', () => {
    const table = createRouteTable()
    const seen: string[] = []
    table.host.webServer.register({
      kind: 'prefix',
      path: '/api',
      handler: () => {
        seen.push('prefix')
      },
    })
    table.host.webServer.register({
      kind: 'exact',
      path: '/api/thing',
      handler: () => {
        seen.push('exact')
      },
    })

    const { req, res } = makeReqRes('/api/thing')
    table.handleRequest(req, res)
    expect(seen).toEqual(['exact'])
  })

  it('picks the LONGEST matching prefix', () => {
    const table = createRouteTable()
    const seen: string[] = []
    for (const path of ['/a', '/a/b', '/a/b/c']) {
      table.host.webServer.register({
        kind: 'prefix',
        path,
        handler: () => {
          seen.push(path)
        },
      })
    }

    const { req, res } = makeReqRes('/a/b/c/deep/file')
    table.handleRequest(req, res)
    expect(seen).toEqual(['/a/b/c'])
  })

  it('matches a prefix only at segment boundaries', () => {
    const table = createRouteTable()
    const seen: string[] = []
    table.host.webServer.register({
      kind: 'prefix',
      path: '/petween-assets',
      handler: () => {
        seen.push('hit')
      },
    })

    const miss = makeReqRes('/petween-assetsX')
    table.handleRequest(miss.req, miss.res)
    expect(miss.status()).toBe(404)
    expect(seen).toEqual([])

    const boundary = makeReqRes('/petween-assets')
    table.handleRequest(boundary.req, boundary.res)
    expect(seen).toEqual(['hit'])
  })

  it('answers 404 itself when no route matches', () => {
    const table = createRouteTable()
    const { req, res, status } = makeReqRes('/nowhere')
    table.handleRequest(req, res)
    expect(status()).toBe(404)
  })

  it('unregister removes the route', () => {
    const table = createRouteTable()
    const unregister = table.host.webServer.register({
      kind: 'exact',
      path: '/gone',
      handler: () => {},
    })
    expect(table.list()).toHaveLength(1)
    unregister()
    expect(table.list()).toHaveLength(0)
    const { req, res, status } = makeReqRes('/gone')
    table.handleRequest(req, res)
    expect(status()).toBe(404)
  })

  it('handles a query string without breaking the path match', () => {
    const table = createRouteTable()
    let hit = false
    table.host.webServer.register({
      kind: 'exact',
      path: '/api/petween/packs/export',
      handler: () => {
        hit = true
      },
    })
    const { req, res } = makeReqRes('/api/petween/packs/export?ids=a,b')
    table.handleRequest(req, res)
    expect(hit).toBe(true)
  })
})
