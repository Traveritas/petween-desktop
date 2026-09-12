/**
 * legacy-import.ts — the optional "import from DSH" data copy. petween's
 * own migrateLegacyHome() refuses to run once the target dir exists — which
 * is always the case here after first boot — so this is a conservative
 * copy-if-absent: assets/animations/pets (+ assets.json) move over, existing
 * files are never overwritten, and the config stays untouched (the user
 * re-picks the imported pet preset in the editor).
 *
 * Pure node:fs — unit-tested against tmpdirs.
 */
import { cpSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_ENTRIES = ['assets', 'assets.json', 'animations', 'pets'] as const

export interface ImportReport {
  copied: string[]
  skipped: string[]
}

export function legacyHomeHasData(legacyRoot: string): boolean {
  return DATA_ENTRIES.some((entry) => existsSync(join(legacyRoot, entry)))
}

export function importLegacyData(legacyRoot: string, targetRoot: string): ImportReport {
  const report: ImportReport = { copied: [], skipped: [] }
  for (const entry of DATA_ENTRIES) {
    const from = join(legacyRoot, entry)
    const to = join(targetRoot, entry)
    if (!existsSync(from) || existsSync(to)) {
      report.skipped.push(entry)
      continue
    }
    cpSync(from, to, { recursive: true, force: false, errorOnExist: true })
    report.copied.push(entry)
  }
  return report
}

/** Offer the menu entry only while the desktop home still has no assets. */
export function targetHomeCanImport(targetRoot: string): boolean {
  const assets = join(targetRoot, 'assets')
  if (existsSync(assets)) {
    try {
      return readdirSync(assets).length === 0
    } catch {
      return false
    }
  }
  return true
}
