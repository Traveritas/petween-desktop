/**
 * End-to-end smoke for the zcode connector transport (docs/06 §2): the REAL
 * chain a zcode hook will drive — curl cfg files on disk → a real curl.exe
 * process → the route table → connector → StateRelay → state-channel —
 * asserted through GET /api/petween/state. Only the zcode client itself is
 * absent (that half is covered by live verification).
 *
 * Skipped when the Windows system curl is unavailable (the repo's primary
 * platform; keeps the suite portable).
 */
import { spawn } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createZcodeConnector, type ZcodeHookKind } from '../../src/main/connectors/zcode-connector'
import { cfgFileName, writeZcodeHookConfigs } from '../../src/main/connectors/zcode-hooks'
import { registerZcodeConnectorRoutes } from '../../src/main/connectors/zcode-routes'
import { startPetweenLocalServer, type PetweenLocalServer } from '../../src/main/local-server'

const CURL = 'C:/Windows/System32/curl.exe'
const editorBundlePath = fileURLToPath(new URL('../../vendor/petween/lib/editor.js', import.meta.url))
const SESSION = 'sess_e2e-0000-0000-0000-000000000000'

let hasCurl = true
try {
  await access(CURL)
} catch {
  hasCurl = false
}

describe.skipIf(!hasCurl)('zcode connector transport (curl → route → relay → state)', () => {
  let dataRoot: string
  let cfgDir: string
  let server: PetweenLocalServer
  let disposeRoutes: () => void
  let disposeConnector: () => void
  let base: string

  beforeAll(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'petween-zcode-e2e-'))
    cfgDir = await mkdtemp(join(tmpdir(), 'petween-zcode-cfg-'))
    server = await startPetweenLocalServer({ dataRoot, editorBundlePath })
    base = `http://127.0.0.1:${server.port}`
    // Exactly what src/main/index.ts writes at every boot.
    await writeZcodeHookConfigs(cfgDir, server.port)

    const connector = createZcodeConnector({ relay: server.relay, now: () => Date.now() })
    disposeConnector = () => connector.dispose()
    disposeRoutes = registerZcodeConnectorRoutes({ webServer: server.webServer }, {
      isEnabled: () => true,
      onHookEvent: (input) => connector.handle(input),
      connectorStatus: async () => ({
        ...connector.status(),
        enabled: true,
        hooksInstalled: false,
      }),
      installHooks: async () => {},
      uninstallHooks: async () => {},
    })
  })

  afterAll(async () => {
    disposeRoutes()
    disposeConnector()
    await server.close()
    await rm(dataRoot, { recursive: true, force: true })
    await rm(cfgDir, { recursive: true, force: true })
  })

  /** Spawns curl exactly the way an installed zcode hook entry does. */
  function fireHook(kind: ZcodeHookKind): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(CURL, ['--config', join(cfgDir, cfgFileName(kind)), '--data-urlencode', `session=${SESSION}`])
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`curl exited ${code} for ${kind}`))))
    })
  }

  async function lastEventType(): Promise<string | null> {
    const res = await fetch(`${base}/api/petween/state`)
    const body = (await res.json()) as { events: Array<{ type: string }> }
    return body.events.length === 0 ? null : (body.events[0]?.type ?? null)
  }

  async function waitForType(expected: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await lastEventType()) === expected) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(await lastEventType()).toBe(expected)
  }

  it('drives the pet state machine through a full turn', async () => {
    await fireHook('user-prompt-submit')
    await waitForType('thinking')

    await fireHook('pre-tool-edit')
    await waitForType('tool-start')
    expect(await toolKind()).toBe('edit')

    await fireHook('post-tool')
    await waitForType('tool-end')

    await fireHook('pre-tool-command')
    await waitForType('tool-start')
    expect(await toolKind()).toBe('command')

    await fireHook('permission-request')
    await waitForType('waiting')

    await fireHook('pre-tool-other')
    await waitForType('tool-start')
    expect(await toolKind()).toBe('other')

    await fireHook('stop')
    await waitForType('success')
  })

  it('reports the session through the connector status endpoint', async () => {
    const res = await fetch(`${base}/api/petween-desktop/connector/zcode/status`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessionsSeen: number; lastKind: string; enabled: boolean }
    expect(body.sessionsSeen).toBe(1)
    expect(body.lastKind).toBe('stop')
    expect(body.enabled).toBe(true)
  })

  async function toolKind(): Promise<string | undefined> {
    const res = await fetch(`${base}/api/petween/state`)
    const body = (await res.json()) as { events: Array<{ toolKind?: string }> }
    return body.events[0]?.toolKind
  }
})
