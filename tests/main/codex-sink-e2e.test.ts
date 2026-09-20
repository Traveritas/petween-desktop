/**
 * Sink-script execution e2e: the generated sink.js is the ONLY non-HTTP
 * delivery path (born from the v0.6.4 forensics) — this drives the real
 * script against a real route-table server, exactly as Codex's hook runner
 * would (node spawn + stdin payload), including the fail-closed paths.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouteTable } from '../../src/main/routes-host'
import { registerCodexConnectorRoutes } from '../../src/main/connectors/codex-routes'
import { writeCodexHookConfigs } from '../../src/main/connectors/codex-hooks'

let server: Server
let base: string
let dispose: () => void
let cfgDir: string

const onHookEvent = vi.fn()
const installHooks = vi.fn(async () => {})

beforeEach(async () => {
  const table = createRouteTable()
  dispose = registerCodexConnectorRoutes(table.host, {
    isEnabled: () => true,
    onHookEvent,
    connectorStatus: async () => ({ enabled: true, hooksInstalled: true, sessionsSeen: 0, lastEventAt: null, lastKind: null, followTarget: null }),
    installHooks,
    uninstallHooks: async () => {},
  })
  server = createServer(table.handleRequest)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  cfgDir = await mkdtemp(join(tmpdir(), 'petween-sink-'))
  await writeCodexHookConfigs(cfgDir, (server.address() as { port: number }).port)
})

afterEach(async () => {
  dispose()
  await new Promise((resolve) => server.close(resolve))
  await rm(cfgDir, { recursive: true, force: true })
  onHookEvent.mockClear()
})

const runSink = (kind: string, payload: string): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(cfgDir, 'sink.js'), kind], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('close', (code) => resolve(code ?? -1))
    child.stdin.end(payload)
  })

describe('sink.js end to end', () => {
  it('delivers the stdin payload through the real route table and exits 0', async () => {
    const code = await runSink('stop', JSON.stringify({ session_id: 'sink_e2e_1', turn_id: 't9' }))
    expect(code).toBe(0)
    await vi.waitFor(() => expect(onHookEvent).toHaveBeenCalled())
    expect(onHookEvent).toHaveBeenCalledWith({
      kind: 'stop',
      sessionId: 'sink_e2e_1',
      payload: { turnId: 't9' },
    })
  })

  it('exits 0 when the server is gone (hooks must never report failure)', async () => {
    await new Promise((resolve) => server.close(resolve))
    const code = await runSink('stop', JSON.stringify({ session_id: 'sink_e2e_2' }))
    expect(code).toBe(0)
    expect(onHookEvent).not.toHaveBeenCalled()
  })

  it('fails CLOSED when the cfg is unreadable (no port fallback)', async () => {
    await rm(join(cfgDir, 'stop.cfg'), { force: true })
    const code = await runSink('stop', JSON.stringify({ session_id: 'sink_e2e_3' }))
    expect(code).toBe(0)
    expect(onHookEvent).not.toHaveBeenCalled()
  })
})
