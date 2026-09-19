/**
 * Full local-server assembly test (docs/05 Phase 1): boots the real petween
 * host halves on an ephemeral node:http port against a temp data root — the
 * same wiring src/main/index.ts performs — and exercises the endpoints the
 * acceptance criteria list: editor page, config/meta APIs, asset upload and
 * static serving, plus persistence across a server restart.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startPetweenLocalServer, type PetweenLocalServer } from '../../src/main/local-server'

const editorBundlePath = fileURLToPath(new URL('../../vendor/petween/lib/editor.js', import.meta.url))
const animatorBundlePath = fileURLToPath(new URL('../../vendor/petween/lib/animator.js', import.meta.url))

/** Minimal valid 1x1 PNG — the host sniffs magic bytes + IHDR only. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function uploadBody(bytes: Buffer, mime: string): FormData {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), 'pose-image')
  return form
}

let dataRoot: string
let server: PetweenLocalServer
let base: string

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'petween-desktop-'))
  server = await startPetweenLocalServer({ dataRoot, editorBundlePath, animatorBundlePath })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(async () => {
  await server.close()
  await rm(dataRoot, { recursive: true, force: true })
})

describe('local-server endpoints', () => {
  it('serves the config API with defaults and empty assets', async () => {
    const res = await fetch(`${base}/api/petween/config`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.config.enabled).toBe('boolean')
    expect(body.assets).toEqual({})
  })

  it('serves the meta API', async () => {
    const res = await fetch(`${base}/api/petween/meta`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok !== undefined || body.apiVersion !== undefined || body.version !== undefined).toBe(true)
  })

  it('serves the editor HTML shell and the real prebuilt bundle', async () => {
    const page = await fetch(`${base}/petween-editor/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('client.js')

    const bundle = await fetch(`${base}/petween-editor/client.js`)
    expect(bundle.status).toBe(200)
    expect(bundle.headers.get('content-type')).toContain('text/javascript')
    const bytes = await bundle.arrayBuffer()
    expect(bytes.byteLength).toBeGreaterThan(100_000) // the real lib/editor.js, not a stub
  })

  it('serves the animator page (Phase 11) with the real prebuilt bundle', async () => {
    const page = await fetch(`${base}/petween-animator/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    const html = await page.text()
    expect(html).toContain('<title>Petween 动画编辑器</title>')
    expect(html).toContain('client.js')

    const bundle = await fetch(`${base}/petween-animator/client.js`)
    expect(bundle.status).toBe(200)
    expect(bundle.headers.get('content-type')).toContain('text/javascript')
    const bytes = await bundle.arrayBuffer()
    expect(bytes.byteLength).toBeGreaterThan(100_000) // the real lib/animator.js, not a stub
  })

  it('uploads an asset, lists it in the config view and serves its bytes', async () => {
    const upload = await fetch(`${base}/api/petween/assets`, {
      method: 'POST',
      body: uploadBody(PNG_1X1, 'image/png'),
    })
    expect(upload.status).toBe(200)
    const { asset } = (await upload.json()) as { asset: { id: string; url: string } }
    expect(asset.id).toMatch(/^[0-9a-f]{16}$/)
    expect(asset.url).toBe(`/petween-assets/${asset.id}`)

    const config = await fetch(`${base}/api/petween/config`)
    const body = (await config.json()) as { assets: Record<string, unknown> }
    expect(Object.keys(body.assets)).toContain(asset.id)

    const raw = await fetch(`${base}/petween-assets/${asset.id}`)
    expect(raw.status).toBe(200)
    expect(Buffer.from(await raw.arrayBuffer()).subarray(1, 4).toString('latin1')).toBe('PNG')
  })

  it('keeps data across a server restart on the same root (independent dir)', async () => {
    await server.close()
    const rebooted = await startPetweenLocalServer({ dataRoot, editorBundlePath, animatorBundlePath })
    try {
      expect(rebooted.port).not.toBe(server.port) // prod uses random ports
      const config = await fetch(`http://127.0.0.1:${rebooted.port}/api/petween/config`)
      const body = (await config.json()) as { assets: Record<string, unknown> }
      expect(Object.keys(body.assets).length).toBe(1)
    } finally {
      await rebooted.close()
    }
  })
})
