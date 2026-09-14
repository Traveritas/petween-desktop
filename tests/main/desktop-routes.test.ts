/**
 * /api/petween-desktop/* route tests: settings roundtrip + validation,
 * status, auto-launch passthrough, fix-interaction and dsh-test probes.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouteTable } from '../../src/main/routes-host'
import { registerDesktopRoutes } from '../../src/main/desktop-routes'
import { createDesktopSettingsStore } from '../../src/main/desktop-settings'

let server: Server
let base: string
let dispose: () => void

const fixInteraction = vi.fn()
const setAutoLaunch = vi.fn()
const probeDsh = vi.fn()

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'petween-droutes-'))
  const table = createRouteTable()
  dispose = registerDesktopRoutes(table.host, {
    settings: await createDesktopSettingsStore(join(dir, 's.json')),
    status: () => ({
      dsh: { enabled: true, connected: true },
      appVersion: '0.1.0-test',
      dataRoot: 'C:\\data',
      serverOrigin: 'http://127.0.0.1:19999',
    }),
    fixInteraction,
    getAutoLaunch: () => true,
    setAutoLaunch,
    probeDsh: probeDsh as unknown as (port: number) => Promise<{ version: string } | null>,
  })
  server = createServer(table.handleRequest)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return async () => {
    dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  fixInteraction.mockClear()
  setAutoLaunch.mockClear()
  probeDsh.mockClear()
})

describe('settings endpoint', () => {
  it('GET returns defaults', async () => {
    const res = await fetch(`${base}/api/petween-desktop/settings`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.settings.dsh.port).toBe(3080)
  })

  it('PUT round-trips a partial patch', async () => {
    const res = await fetch(`${base}/api/petween-desktop/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clickThrough: { mode: 'always-through' } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.settings.clickThrough.mode).toBe('always-through')
    expect(body.settings.clickThrough.hitPaddingPx).toBe(6) // untouched

    const after = await (await fetch(`${base}/api/petween-desktop/settings`)).json()
    expect(after.settings.clickThrough.mode).toBe('always-through')
  })

  it('rejects broken JSON with 400', async () => {
    const res = await fetch(`${base}/api/petween-desktop/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    })
    expect(res.status).toBe(400)
  })
})

describe('status / autolaunch / fix-interaction / dsh-test', () => {
  it('status returns the injected snapshot', async () => {
    const body = await (await fetch(`${base}/api/petween-desktop/status`)).json()
    expect(body).toEqual({
      dsh: { enabled: true, connected: true },
      appVersion: '0.1.0-test',
      dataRoot: 'C:\\data',
      serverOrigin: 'http://127.0.0.1:19999',
    })
  })

  it('autolaunch GET/PUT passthrough', async () => {
    expect(await (await fetch(`${base}/api/petween-desktop/autolaunch`)).json()).toEqual({ enabled: true })
    const put = await fetch(`${base}/api/petween-desktop/autolaunch`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(put.status).toBe(200)
    expect(setAutoLaunch).toHaveBeenCalledWith(false)
    const bad = await fetch(`${base}/api/petween-desktop/autolaunch`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    })
    expect(bad.status).toBe(400)
  })

  it('fix-interaction invokes the handler', async () => {
    const res = await fetch(`${base}/api/petween-desktop/fix-interaction`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(fixInteraction).toHaveBeenCalledTimes(1)
  })

  it('dsh-test probes the requested port', async () => {
    probeDsh.mockResolvedValueOnce({ version: '0.1.0-rc.7' })
    const ok = await (
      await fetch(`${base}/api/petween-desktop/dsh-test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: 3080 }),
      })
    ).json()
    expect(ok).toEqual({ ok: true, version: '0.1.0-rc.7' })
    expect(probeDsh).toHaveBeenCalledWith(3080)

    probeDsh.mockResolvedValueOnce(null)
    const miss = await (
      await fetch(`${base}/api/petween-desktop/dsh-test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: 3081 }),
      })
    ).json()
    expect(miss).toEqual({ ok: false, version: null })

    const invalid = await fetch(`${base}/api/petween-desktop/dsh-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 99999 }),
    })
    expect(invalid.status).toBe(400)
  })
})
