/**
 * Route-table dispatch semantics: exact-first, then longest matching prefix,
 * 404 when nothing matches, unregister removes the route (docs/02 §2 —
 * the adapter must behave like the DSH webServer the handlers were written
 * for; reference: petween tests/host/routes.test.ts:78-108).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createRouteTable } from '../../src/main/routes-host'

function makeReqRes(url: string, host?: string): { req: IncomingMessage; res: ServerResponse; status: () => number | undefined; body: () => string } {
  const state = { status: undefined as number | undefined, body: '', ended: false }
  const req = { method: 'GET', url, headers: host === undefined ? {} : { host } } as IncomingMessage
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

describe('Host fence (setAllowedHosts — DNS-rebinding defence, v0.4.0 review)', () => {
  const registerEcho = (table: ReturnType<typeof createRouteTable>): void => {
    table.host.webServer.register({
      kind: 'exact',
      path: '/api/echo',
      handler: (_req, res) => {
        res.writeHead(200).end('hit')
      },
    })
  }

  it('403s a foreign Host before any handler runs, GET included', () => {
    const table = createRouteTable()
    registerEcho(table)
    table.setAllowedHosts(new Set(['127.0.0.1:17777']))
    const { req, res, status, body } = makeReqRes('/api/echo', 'attacker.example:17777')
    table.handleRequest(req, res)
    expect(status()).toBe(403)
    expect(body()).toContain('FORBIDDEN_HOST')
  })

  it('allows exact matches, case-insensitively', () => {
    const table = createRouteTable()
    registerEcho(table)
    table.setAllowedHosts(new Set(['LocalHost:17777', '127.0.0.1:17777']))
    const lower = makeReqRes('/api/echo', 'localhost:17777')
    table.handleRequest(lower.req, lower.res)
    expect(lower.status()).toBe(200)
    const upper = makeReqRes('/api/echo', '127.0.0.1:17777')
    table.handleRequest(upper.req, upper.res)
    expect(upper.status()).toBe(200)
  })

  it('missing Host header is rejected once the fence is armed', () => {
    const table = createRouteTable()
    registerEcho(table)
    table.setAllowedHosts(new Set(['127.0.0.1:17777']))
    const { req, res, status } = makeReqRes('/api/echo') // no headers at all
    table.handleRequest(req, res)
    expect(status()).toBe(403)
  })

  it('unset = allow all (route-table unit-test semantics preserved)', () => {
    const table = createRouteTable()
    registerEcho(table)
    const { req, res, status } = makeReqRes('/api/echo', 'anything.example')
    table.handleRequest(req, res)
    expect(status()).toBe(200)
  })
})
