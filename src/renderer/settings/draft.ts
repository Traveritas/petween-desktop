/**
 * settings/draft.ts — the pure half of the per-page draft model (Phase 18
 * settings rework): dirty tracking is a structural compare over the page's
 * slice. The settings document is plain JSON (desktop-settings normalizes
 * it), so no exotic cases needed — primitives, arrays, plain objects.
 */

/** Structural equality over JSON-shaped values. */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  const bKeys = Object.keys(bRecord)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRecord, key)) return false
    if (!jsonDeepEqual(aRecord[key], bRecord[key])) return false
  }
  return true
}
