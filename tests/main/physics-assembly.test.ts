/**
 * physics desktop assembly tests (docs/05 Phase 8C): the host half lands on
 * a bare route table with an explicit data path, the config API round-trips
 * through it, and the factory bounce animation registers into the real
 * petween companion host service.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnimationsStore } from 'petween/host/animations'
import { createPetweenHostService } from 'petween/host/service'
import { createWriteLock } from 'petween/host/storage'
import { assemblePhysics } from '../../src/main/physics-assembly'
import { createRouteTable } from '../../src/main/routes-host'

let dir: string
let server: Server
let base: string
let dispose: (() => void) | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'petween-physics-asm-'))
})
afterEach(async () => {
  dispose?.dispose()
  dispose = null
  if (server !== undefined) await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

describe('assemblePhysics', () => {
  it('serves the physics config API and persists under the injected path', async () => {
    const animationsStore = new AnimationsStore({
      animationsDir: join(dir, 'animations'),
      lock: createWriteLock(),
    })
    const petweenHostService = createPetweenHostService(animationsStore)
    const table = createRouteTable()
    dispose = assemblePhysics({
      host: table.host,
      petweenHostService,
      configPath: join(dir, 'petween-physics', 'config.json'),
    })

    server = createServer(table.handleRequest)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    const initial = await fetch(`${base}/api/petween-physics/config`)
    expect(initial.status).toBe(200)
    const body = (await initial.json()) as { config: Record<string, unknown> }
    expect(body.config).toBeTruthy()

    // a bogus patch is rejected by the plugin's strict validation
    const bad = await fetch(`${base}/api/petween-physics/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gravityPxPerS2: 'not-a-number' }),
    })
    expect(bad.status).toBe(400)

    // a valid no-op patch persists the current config under the injected path
    // (the store itself is lazy: first load serves defaults in memory only)
    const put = await fetch(`${base}/api/petween-physics/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(put.status).toBe(200)
    const persisted = JSON.parse(await readFile(join(dir, 'petween-physics', 'config.json'), 'utf8'))
    expect(persisted).toBeTruthy()
  })

  it('registers the factory bounce animation through the petween host service', async () => {
    const animationsStore = new AnimationsStore({
      animationsDir: join(dir, 'animations'),
      lock: createWriteLock(),
    })
    const petweenHostService = createPetweenHostService(animationsStore)
    dispose = assemblePhysics({
      host: createRouteTable().host,
      petweenHostService,
      configPath: join(dir, 'p2', 'config.json'),
    })
    // ensureBounceAnimation is fire-and-forget; wait for the store to list it.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { customs } = await animationsStore.loadAll()
      if (customs.length > 0) {
        expect(customs.some((animation) => animation.id.startsWith('user:'))).toBe(true)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('bounce animation never registered')
  })
})
