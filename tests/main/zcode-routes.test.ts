/**
 * zcode connector routes: the hook event sink (validation + fence + 204 fast
 * path), status passthrough, install/uninstall actions. Same real-HTTP-over-
 * route-table pattern as desktop-routes.test.ts.
 */
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouteTable } from '../../src/main/routes-host'
import { registerZcodeConnectorRoutes } from '../../src/main/connectors/zcode-routes'

let server: Server
let base: string
let dispose: () => void

const isEnabled = vi.fn(() => true)
const onHookEvent = vi.fn()
const installHooks = vi.fn(async () => {})
const uninstallHooks = vi.fn(async () => {})
const connectorStatus = vi.fn(async () => ({
  enabled: true,
  hooksInstalled: false,
  sessionsSeen: 0,
  lastEventAt: null,
  lastKind: null,
  followTarget: null,
}))

const EVENT = '/api/petween-desktop/connector/zcode/event'

beforeEach(async () => {
  const table = createRouteTable()
  dispose = registerZcodeConnectorRoutes(table.host, {
    isEnabled,
    onHookEvent,
    connectorStatus,
    installHooks,
    uninstallHooks,
  })
  server = createServer(table.handleRequest)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  onHookEvent.mockClear()
  installHooks.mockClear()
  uninstallHooks.mockClear()
})

describe('event sink', () => {
  it('accepts a hook POST (urlencoded body) and always 204s', async () => {
    const res = await fetch(`${base}${EVENT}?e=pre-tool-edit`, {
      method: 'POST',
      body: 'session=sess_abcd-1234',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(res.status).toBe(204)
    expect(onHookEvent).toHaveBeenCalledWith({ kind: 'pre-tool-edit', sessionId: 'sess_abcd-1234' })
  })

  it('rejects unknown kinds and malformed session ids', async () => {
    const badKind = await fetch(`${base}${EVENT}?e=nonsense`, { method: 'POST', body: 'session=sess_x' })
    expect(badKind.status).toBe(400)
    const missingKind = await fetch(base + EVENT, { method: 'POST', body: 'session=sess_x' })
    expect(missingKind.status).toBe(400)
    const badSession = await fetch(`${base}${EVENT}?e=stop`, { method: 'POST', body: 'session=<script>' })
    expect(badSession.status).toBe(400)
    expect(onHookEvent).not.toHaveBeenCalled()
  })

  it('drops events when the connector is disabled but still 204s', async () => {
    isEnabled.mockReturnValueOnce(false)
    const res = await fetch(`${base}${EVENT}?e=stop`, { method: 'POST', body: 'session=sess_x' })
    expect(res.status).toBe(204)
    expect(onHookEvent).not.toHaveBeenCalled()
  })

  it('blocks cross-origin writes (browser fence), allows local processes', async () => {
    const cross = await fetch(`${base}${EVENT}?e=stop`, {
      method: 'POST',
      body: 'session=sess_x',
      headers: { origin: 'https://evil.example' },
    })
    expect(cross.status).toBe(403)
    expect(onHookEvent).not.toHaveBeenCalled()
  })

  it('rejects non-POST on the sink', async () => {
    const res = await fetch(`${base}${EVENT}?e=stop`)
    expect(res.status).toBe(405)
  })
})

describe('event sink payload bodies (Phase 10, docs/06 §8)', () => {
  const spikeShape = {
    sessionId: 'sess_abcd-1234',
    session_id: 'sess_abcd-1234',
    hookEventName: 'PreToolUse',
    toolName: 'Edit',
    tool_name: 'Edit',
    toolInput: { file_path: 'D:/x/a.ts', old_string: 'a\nb', new_string: 'a\nB\nc' },
    tool_input: { file_path: 'D:/x/a.ts', old_string: 'a\nb', new_string: 'a\nB\nc' },
    timestamp: '2026-09-18T15:27:18.165Z',
    turnId: 'turn_1',
  }

  it('parses the stdin JSON body and forwards the payload', async () => {
    const res = await fetch(`${base}${EVENT}?e=pre-tool-edit`, {
      method: 'POST',
      body: JSON.stringify(spikeShape),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(204)
    expect(onHookEvent).toHaveBeenCalledWith({
      kind: 'pre-tool-edit',
      sessionId: 'sess_abcd-1234',
      payload: {
        toolName: 'Edit',
        toolInput: spikeShape.tool_input,
        turnId: 'turn_1',
        at: Date.parse('2026-09-18T15:27:18.165Z'),
      },
    })
  })

  it('strips a trailing &session= pair (transitional install mixing urlencode with data-binary)', async () => {
    const body = `${JSON.stringify(spikeShape)}&session=sess_abcd-1234`
    const res = await fetch(`${base}${EVENT}?e=post-tool`, { method: 'POST', body })
    expect(res.status).toBe(204)
    expect(onHookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'post-tool', sessionId: 'sess_abcd-1234', payload: expect.anything() }),
    )
  })

  it('malformed JSON is rejected (no usable session id)', async () => {
    const res = await fetch(`${base}${EVENT}?e=stop`, { method: 'POST', body: '{"broken":' })
    expect(res.status).toBe(400)
    expect(onHookEvent).not.toHaveBeenCalled()
  })

  it('JSON without any session id field is rejected', async () => {
    const res = await fetch(`${base}${EVENT}?e=stop`, { method: 'POST', body: '{"toolName":"Bash"}' })
    expect(res.status).toBe(400)
  })

  it('bodies over 1 MB are rejected', async () => {
    const huge = `{"session_id":"sess_x","pad":"${'x'.repeat(1100 * 1024)}"}`
    const res = await fetch(`${base}${EVENT}?e=stop`, { method: 'POST', body: huge })
    expect(res.status).toBe(413)
  })
})

describe('status and actions', () => {
  it('status returns the connector snapshot', async () => {
    const res = await fetch(`${base}/api/petween-desktop/connector/zcode/status`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ enabled: true, hooksInstalled: false })
  })

  it('install and uninstall call through and report ok', async () => {
    const install = await fetch(`${base}/api/petween-desktop/connector/zcode/install`, { method: 'POST' })
    expect(install.status).toBe(200)
    expect(await install.json()).toEqual({ ok: true })
    expect(installHooks).toHaveBeenCalledTimes(1)

    const uninstall = await fetch(`${base}/api/petween-desktop/connector/zcode/uninstall`, { method: 'POST' })
    expect(uninstall.status).toBe(200)
    expect(uninstallHooks).toHaveBeenCalledTimes(1)
  })

  it('action failures surface as 500 INSTALL_FAILED', async () => {
    installHooks.mockRejectedValueOnce(new Error('config is not valid JSON'))
    const res = await fetch(`${base}/api/petween-desktop/connector/zcode/install`, { method: 'POST' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INSTALL_FAILED')
    expect(body.error.message).toContain('not valid JSON')
  })

  it('actions are fenced against cross-origin writes', async () => {
    const res = await fetch(`${base}/api/petween-desktop/connector/zcode/install`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    expect(installHooks).not.toHaveBeenCalled()
  })
})
