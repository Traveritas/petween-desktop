/**
 * codex connector routes: the hook event sink (Codex stdin JSON with
 * turn_id/transcript_path), status passthrough, install/uninstall. Same
 * real-HTTP-over-route-table pattern as cc-routes.test.ts.
 */
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouteTable } from '../../src/main/routes-host'
import { registerCodexConnectorRoutes, parseCodexHookBody } from '../../src/main/connectors/codex-routes'

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

const EVENT = '/api/petween-desktop/connector/codex/event'

beforeEach(async () => {
  const table = createRouteTable()
  dispose = registerCodexConnectorRoutes(table.host, {
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
  isEnabled.mockClear()
  connectorStatus.mockClear()
  installHooks.mockClear()
  uninstallHooks.mockClear()
})

describe('parseCodexHookBody', () => {
  it('maps the Codex stdin schema: session_id, turn_id, transcript_path, tool_name, tool_input', () => {
    const parsed = parseCodexHookBody(
      JSON.stringify({
        session_id: 'codex_s1',
        turn_id: 'turn_42',
        transcript_path: 'C:/Users/t/.codex/sessions/2026/09/20/rollout-x-codex_s1.jsonl',
        cwd: 'D:/proj',
        hook_event_name: 'PreToolUse',
        model: 'gpt-6-astra',
        permission_mode: 'workspace-write',
        tool_name: 'apply_patch',
        tool_input: { path: 'a.ts', patch: '*** Update' },
        tool_use_id: 'tu_1',
      }),
    )
    expect(parsed).toEqual({
      sessionId: 'codex_s1',
      payload: {
        toolName: 'apply_patch',
        turnId: 'turn_42',
        transcriptPath: 'C:/Users/t/.codex/sessions/2026/09/20/rollout-x-codex_s1.jsonl',
        toolInput: { path: 'a.ts', patch: '*** Update' },
      },
    })
  })

  it('a null transcript_path and absent optionals are simply omitted', () => {
    const parsed = parseCodexHookBody(JSON.stringify({ session_id: 'codex_s1', transcript_path: null }))
    expect(parsed).toEqual({ sessionId: 'codex_s1', payload: {} })
  })

  it('non-JSON or session-less bodies yield an empty session id', () => {
    expect(parseCodexHookBody('legacy')).toEqual({ sessionId: '' })
    expect(parseCodexHookBody('{ broken')).toEqual({ sessionId: '' })
    expect(parseCodexHookBody('{}')).toEqual({ sessionId: '' })
  })
})

describe('event sink', () => {
  it('accepts a Codex stdin JSON POST and always 204s', async () => {
    const res = await fetch(`${base}${EVENT}?e=pre-tool-edit`, {
      method: 'POST',
      body: JSON.stringify({ session_id: 'codex_abcd-1234', turn_id: 't1', tool_name: 'apply_patch', tool_input: { patch: 'x' } }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(204)
    expect(onHookEvent).toHaveBeenCalledWith({
      kind: 'pre-tool-edit',
      sessionId: 'codex_abcd-1234',
      payload: { toolName: 'apply_patch', turnId: 't1', toolInput: { patch: 'x' } },
    })
  })

  it('reclassifies the bare PreToolUse group by the payload tool_name (Rust regex has no look-around)', async () => {
    const post = async (toolName: string): Promise<string> => {
      const res = await fetch(`${base}${EVENT}?e=pre-tool-other`, {
        method: 'POST',
        body: JSON.stringify({ session_id: 'codex_x', tool_name: toolName, tool_input: {} }),
      })
      expect(res.status).toBe(204)
      return (onHookEvent.mock.calls.at(-1)?.[0] as { kind: string }).kind
    }
    expect(await post('apply_patch')).toBe('pre-tool-edit')
    expect(await post('Bash')).toBe('pre-tool-command')
    expect(await post('read_file')).toBe('pre-tool-other')
    // A payload-less event stays whatever the cfg encoded.
    const bare = await fetch(`${base}${EVENT}?e=stop`, { method: 'POST', body: JSON.stringify({ session_id: 'codex_x' }) })
    expect(bare.status).toBe(204)
    expect((onHookEvent.mock.calls.at(-1)?.[0] as { kind: string }).kind).toBe('stop')
  })

  it('rejects unknown kinds, missing sessions and malformed ids; blocks cross-origin; 405s non-POST', async () => {
    expect((await fetch(`${base}${EVENT}?e=nonsense`, { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await fetch(`${base}${EVENT}?e=stop`, { method: 'POST', body: JSON.stringify({}) })).status).toBe(400)
    expect((await fetch(`${base}${EVENT}?e=stop`, { method: 'POST', body: JSON.stringify({ session_id: 'a b' }) })).status).toBe(400)
    const cross = await fetch(`${base}${EVENT}?e=stop`, {
      method: 'POST',
      body: JSON.stringify({ session_id: 'codex_x' }),
      headers: { origin: 'https://evil.example' },
    })
    expect(cross.status).toBe(403)
    expect((await fetch(base + EVENT)).status).toBe(405)
    expect(onHookEvent).not.toHaveBeenCalled()
  })

  it('drops events when the connector is disabled but still 204s', async () => {
    isEnabled.mockReturnValueOnce(false)
    const res = await fetch(`${base}${EVENT}?e=stop`, { method: 'POST', body: JSON.stringify({ session_id: 'codex_x' }) })
    expect(res.status).toBe(204)
    expect(onHookEvent).not.toHaveBeenCalled()
  })
})

describe('status / install / uninstall', () => {
  it('status, install and uninstall pass through; failures surface as 500', async () => {
    const status = await fetch(base + '/api/petween-desktop/connector/codex/status')
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ enabled: true, hooksInstalled: false })

    const install = await fetch(base + '/api/petween-desktop/connector/codex/install', { method: 'POST' })
    expect(install.status).toBe(200)
    expect(installHooks).toHaveBeenCalledTimes(1)

    installHooks.mockRejectedValueOnce(new Error('untrusted hash'))
    const failing = await fetch(base + '/api/petween-desktop/connector/codex/install', { method: 'POST' })
    expect(failing.status).toBe(500)
    expect(((await failing.json()) as { error: { message: string } }).error.message).toContain('untrusted hash')

    const uninstall = await fetch(base + '/api/petween-desktop/connector/codex/uninstall', { method: 'POST' })
    expect(uninstall.status).toBe(200)
    expect(uninstallHooks).toHaveBeenCalledTimes(1)
  })
})
