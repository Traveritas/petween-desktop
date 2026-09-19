/**
 * Tray template state mapping + the copy-if-absent legacy import.
 */
import { mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTrayTemplate } from '../../src/main/tray-menu'
import {
  importLegacyData,
  legacyHomeHasData,
  targetHomeCanImport,
} from '../../src/main/legacy-import'

describe('buildTrayTemplate', () => {
  it('reflects DSH status and auto-launch state', () => {
    const on = buildTrayTemplate({
      dshConnected: true,
      autoLaunchEnabled: true,
      canToggleAutoLaunch: true,
      canImportFromDsh: false,
    })
    expect(on[0]).toEqual({ label: 'DSH：已连接', enabled: false })
    const autoLaunch = on.find((item) => item.action === 'toggle-auto-launch')
    expect(autoLaunch).toMatchObject({ type: 'checkbox', checked: true, enabled: true })

    const off = buildTrayTemplate({
      dshConnected: false,
      autoLaunchEnabled: false,
      canToggleAutoLaunch: false,
      canImportFromDsh: true,
    })
    expect(off[0]).toEqual({ label: 'DSH：未连接', enabled: false })
    expect(off.find((item) => item.action === 'toggle-auto-launch')).toMatchObject({
      checked: false,
      enabled: false, // dev: the checkbox would register bare electron.exe
    })
    expect(off.some((item) => item.action === 'import-from-dsh')).toBe(true)
    expect(on.some((item) => item.action === 'import-from-dsh')).toBe(false)
  })

  it('always keeps settings, animator and quit entries', () => {
    const template = buildTrayTemplate({
      dshConnected: false,
      autoLaunchEnabled: false,
      canToggleAutoLaunch: false,
      canImportFromDsh: false,
    })
    expect(template.some((item) => item.action === 'open-settings')).toBe(true)
    expect(template.some((item) => item.action === 'open-animator')).toBe(true)
    expect(template.some((item) => item.action === 'quit')).toBe(true)
  })
})

describe('legacy import (copy-if-absent)', () => {
  async function makeHome(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), prefix))
  }

  it('copies missing entries and never overwrites existing ones', async () => {
    const legacy = await makeHome('petween-legacy-')
    const target = await makeHome('petween-target-')
    try {
      await mkdir(join(legacy, 'assets'))
      await writeFile(join(legacy, 'assets', 'a.png'), 'png')
      await writeFile(join(legacy, 'assets.json'), '{}')
      await mkdir(join(legacy, 'animations'))
      // target already owns an animations dir
      await mkdir(join(target, 'animations'))
      await writeFile(join(target, 'animations', 'keep.json'), 'x')

      const report = importLegacyData(legacy, target)
      expect(report.copied.sort()).toEqual(['assets', 'assets.json'])
      expect(report.skipped.sort()).toEqual(['animations', 'pets'])

      expect(await readdir(join(target, 'assets'))).toEqual(['a.png'])
      expect(await readdir(join(target, 'animations'))).toEqual(['keep.json'])
      expect(legacyHomeHasData(legacy)).toBe(true)
    } finally {
      await rm(legacy, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    }
  })

  it('offers import only while the target has no assets', async () => {
    const home = await makeHome('petween-canimport-')
    try {
      expect(targetHomeCanImport(home)).toBe(true)
      await mkdir(join(home, 'assets'))
      await writeFile(join(home, 'assets', 'x.png'), 'x')
      expect(targetHomeCanImport(home)).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('reports an empty legacy home as having nothing to offer', () => {
    expect(legacyHomeHasData(join(tmpdir(), 'petween-no-such-home-xyz'))).toBe(false)
  })
})
