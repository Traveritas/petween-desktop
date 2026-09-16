/**
 * dsh-client tests (2026-09-16 milestone review gap #2): the HTTP RPC
 * contract against a canned node:http server — envelope shape, method/URL
 * consistency, content-type, response validation, and describeDsh's
 * null-on-failure semantics (this backs both the bridge probe and the
 * settings DSH-test button).
 */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { describeDsh, postRpc } from '../../src/main/dsh-bridge/dsh-client'

let server: Server | null = null

afterEach(async () => {
  if (server !== null) {
    await new Promise((resolve) => server!.close(resolve))
    server = null
  }
})

function serve(
  handler: (req: Parameters<Parameters<typeof createServer>[0]>[0], body: string | null, respond: (status: number, body: string) => void) => void,
): Promise<number> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      handler(req, Buffer.concat(chunks).toString('utf8'), (status, responseBody) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(responseBody)
      })
    })
  })
  return new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port)))
}

describe('postRpc', () => {
  it('sends the client-request envelope with matching method and json content-type', async () => {
    let seen: { url?: string; method?: string; contentType?: string; body?: unknown } | null = null
    const port = await serve((req, body, respond) => {
      seen = {
        url: req.url,
        method: req.method,
        contentType: req.headers['content-type'],
        body: JSON.parse(body ?? '{}'),
      }
      respond(200, JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: true, value: { version: 'v1' } } }))
    })
    const value = await postRpc<{ version: string }>(port, 'host.describe', { a: 1 })
    expect(value).toEqual({ version: 'v1' })
    expect(seen!.url).toBe('/api/host.describe')
    expect(seen!.method).toBe('POST')
    expect(seen!.contentType).toBe('application/json')
    const envelope = seen!.body as { type: string; method: string; payload: unknown }
    expect(envelope.type).toBe('client-request')
    expect(envelope.method).toBe('host.describe')
    expect(envelope.payload).toEqual({ a: 1 })
  })

  it('rejects non-ok results, wrong envelope types, and HTTP errors', async () => {
    const port = await serve((_req, _body, respond) => {
      respond(200, JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: false, error: { message: 'boom' } } }))
    })
    await expect(postRpc(port, 'host.describe', {})).rejects.toThrow('boom')

    const port2 = await new Promise<number>((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'something-else' }))
      })
      server.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port))
    })
    await expect(postRpc(port2, 'host.describe', {})).rejects.toThrow('rpc failed')

    const port3 = await new Promise<number>((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(500)
        res.end('nope')
      })
      server.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port))
    })
    await expect(postRpc(port3, 'host.describe', {})).rejects.toThrow('HTTP 500')
  })
})

describe('describeDsh', () => {
  it('returns the version when DSH answers, null when anything fails', async () => {
    const port = await serve((_req, _body, respond) => {
      respond(200, JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: true, value: { version: '0.1.0-rc.7', cwd: 'C:\\x' } } }))
    })
    expect(await describeDsh(port)).toEqual({ version: '0.1.0-rc.7', cwd: 'C:\\x' })

    // non-version value → treated as not-DSH
    const port2 = await serve((_req, _body, respond) => {
      respond(200, JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: true, value: { cwd: 'C:\\x' } } }))
    })
    expect(await describeDsh(port2)).toBeNull()

    // nothing listening → null, not a throw
    expect(await describeDsh(1)).toBeNull()
  })
})
