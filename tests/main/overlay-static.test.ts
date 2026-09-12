/**
 * overlay-static tests: the prod same-origin serving of the electron-vite
 * renderer build — page aliases, asset MIME types, traversal guards.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRouteTable } from '../../src/main/routes-host'
import { registerOverlayStatic } from '../../src/main/overlay-static'

let dist: string
let server: Server
let base: string

beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), 'petween-ostatic-'))
  await mkdir(join(dist, 'overlay'), { recursive: true })
  await mkdir(join(dist, 'assets'), { recursive: true })
  await writeFile(join(dist, 'overlay', 'index.html'), '<!doctype html><title>overlay</title>')
  await writeFile(join(dist, 'assets', 'overlay-DR25IQPC.js'), 'console.log("overlay")')

  const table = createRouteTable()
  const dispose = registerOverlayStatic(table.host, dist)
  server = createServer(table.handleRequest)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return () => dispose()
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(dist, { recursive: true, force: true })
})

describe('overlay page aliases', () => {
  it('serves the page at /overlay.html, /overlay and /overlay/index.html', async () => {
    for (const path of ['/overlay.html', '/overlay', '/overlay/index.html']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(await res.text()).toContain('overlay')
    }
  })
})

describe('asset serving', () => {
  it('serves hashed chunks with the right MIME type', async () => {
    const res = await fetch(`${base}/assets/overlay-DR25IQPC.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    expect(await res.text()).toContain('console.log')
  })

  it('404s for missing files', async () => {
    const res = await fetch(`${base}/assets/missing.js`)
    expect(res.status).toBe(404)
  })

  it('rejects traversal attempts', async () => {
    // WHATWG URL collapses ../ during parsing — lands outside the prefix.
    const collapsed = await fetch(`${base}/assets/../package.json`)
    expect(collapsed.status).toBe(404)
    // Encoded dots survive parsing — the resolve+startsWith guard catches them.
    const encoded = await fetch(`${base}/assets/%2e%2e%2f%2e%2e%2fpackage.json`)
    expect(encoded.status).toBe(404)
  })
})
