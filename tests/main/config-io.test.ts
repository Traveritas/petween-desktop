/**
 * config-io hardening (v0.7.0 review): ENOENT-only fresh-install semantics,
 * tmp cleanup on failed rename.
 */
import { mkdtemp, readFile, rm, writeFile, chmod, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readConfigObject, writeConfigAtomic } from '../../src/main/connectors/config-io'

describe('readConfigObject error semantics', () => {
  it('ENOENT → null (fresh install)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'petween-cfgio-'))
    try {
      expect(await readConfigObject(join(dir, 'absent.json'))).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('non-ENOENT read failures rethrow — a transient EBUSY/EPERM must not read as "fresh install" and collapse the config on write-back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'petween-cfgio-'))
    try {
      const file = join(dir, 'locked.json')
      await writeFile(file, '{"hooks":{}}', 'utf8')
      await chmod(file, 0o000)
      // On Windows chmod is advisory; simulate the class of failure via a
      // directory read (EISDIR — a non-ENOENT error code path).
      await expect(readConfigObject(dir)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('writeConfigAtomic tmp hygiene', () => {
  it('no .petween-tmp-* residue after a successful write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'petween-cfgio-'))
    try {
      const file = join(dir, 'config.json')
      await writeConfigAtomic(file, { hooks: { a: 1 } })
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ hooks: { a: 1 } })
      expect((await readdir(dir)).filter((name) => name.includes('petween-tmp'))).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
