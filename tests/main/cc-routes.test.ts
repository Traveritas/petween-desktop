/**
 * cc connector routes: the hook event sink (CC stdin JSON validation + fence
 * + 204 fast path), status passthrough, install/uninstall actions. Same
 * real-HTTP-over-route-table pattern as zcode-routes.test.ts.
 */
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouteTable } from '../../src/main/routes-host'
import { registerCcConnectorRoutes } from '../../src/main/connectors/cc-routes'
import { parseCcHookBody } from '../../src/main/connectors/cc-routes'

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

const EVENT = '/api/petween-desktop/connector/cc/event'

beforeEach(async () => {
  const table = createRouteTable()
  dispose = registerCcConnectorRoutes(table.host, {
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

describe('parseCcHookBody', () => {
  it('maps the CC stdin shape: session_id, prompt_id → turnId, tool_name, tool_input', () => {
    const parsed = parseCcHookBody(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'cc_s1',
        prompt_id: 'prompt_42',
        transcript_path: '~/.claude/projects/x/cc_s1.jsonl',
        cwd: 'D:/proj',
        tool_name: 'Edit',
        tool_input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
      }),
    )
    expect(parsed).toEqual({
      sessionId: 'cc_s1',
      payload: {
        toolName: 'Edit',
        turnId: 'prompt_42',
        toolInput: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
      },
    })
  })

  it('non-JSON or session-less bodies yield an empty session id', () => {
    expect(parseCcHookBody('session=legacy')).toEqual({ sessionId: '' })
    expect(parseCcHookBody('{ broken')).toEqual({ sessionId: '' })
    expect(parseCcHookBody('{}')).toEqual({ sessionId: '' })
  })
})

describe('event sink', () => {
  it('accepts a CC stdin JSON POST and always 204s', async () => {
    const res = await fetch(`${base}${EVENT}?e=pre-tool-edit`, {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'cc_abcd-1234', prompt_id: 'p1', tool_name: 'Edit', tool_input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(204)
    expect(onHookEvent).toHaveBeenCalledWith({
      kind: 'pre-tool-edit',
      sessionId: 'cc_abcd-1234',
      payload: { toolName: 'Edit', turnId: 'p1', toolInput: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } },
    })
  })

  it('rejects unknown kinds, missing bodies and malformed session ids', async () => {
    const badKind = await fetch(`${base}${EVENT}?e=nonsense`, { method: 'POST', body: '{}' })
    expect(badKind.status).toBe(400)
    const noSession = await fetch(`${base}${EVENT}?e=stop`, { method: 'POST', body: JSON.stringify({ hook_event_name: 'Stop' }) })
    expect(noSession.status).toBe(400)
    const badSession = await fetch(`${base}${EVENT}?e=stop`, { method: 'POST', body: JSON.stringify({ session_id: '<script>' }) })
    expect(badSession.status).toBe(400)
    expect(onHookEvent).not.toHaveBeenCalled()
  })

  it('drops events when the connector is disabled but still 204s', async () => {
    isEnabled.mockReturnValueOnce(false)
    const res = await fetch(`${base}${EVENT}?e=stop`, { method: 'POST', body: JSON.stringify({ session_id: 'cc_x' }) })
    expect(res.status).toBe(204)
    expect(onHookEvent).not.toHaveBeenCalled()
  })

  it('blocks cross-origin writes (browser fence)', async () => {
    const cross = await fetch(`${base}${EVENT}?e=stop`, {
      method: 'POST',
      body: JSON.stringify({ session_id: 'cc_x' }),
      headers: { origin: 'https://evil.example' },
    })
    expect(cross.status).toBe(403)
    expect(onHookEvent).not.toHaveBeenCalled()
  })

  it('rejects non-POST on the sink', async () => {
    const res = await fetch(base + EVENT)
    expect(res.status).toBe(405)
  })
})

describe('status / install / uninstall', () => {
  it('status passes the connector status through', async () => {
    const res = await fetch('/api/petween-desktop/connector/cc/status'.replace(/^/, base))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ enabled: true, hooksInstalled: false })
  })

  it('install and uninstall POST through', async () => {
    const install = await fetch(base + '/api/petween-desktop/connector/cc/install', { method: 'POST' })
    expect(install.status).toBe(200)
    expect(await install.json()).toEqual({ ok: true })
    expect(installHooks).toHaveBeenCalledTimes(1)
    const uninstall = await fetch(base + '/api/petween-desktop/connector/cc/uninstall', { method: 'POST' })
    expect(uninstall.status).toBe(200)
    expect(uninstallHooks).toHaveBeenCalledTimes(1)
  })

  it('install failures surface as 500 with the message', async () => {
    installHooks.mockRejectedValueOnce(new Error('settings busy'))
    const res = await fetch(base + '/api/petween-desktop/connector/cc/install', { method: 'POST' })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('settings busy')
  })
})
