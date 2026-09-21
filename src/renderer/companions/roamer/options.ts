/**
 * roamer/options.ts — normalize the raw option bag (desktop-settings
 * companions.options['roamer']) into RoamerOptions: defaults for absent
 * keys, clamps for numeric ranges, silent drops for garbage. Mirrors the
 * stats-hud normalizeOptions discipline — the runtime polls every 3s and
 * the settings card PUTs merged bags, so both sides must agree on shape.
 */
import type {
  IdleActionId,
  MischiefActionId,
  RoamerContentItem,
  RoamerIdleOptions,
  RoamerMischiefOptions,
  RoamerOptions,
  RoamerWanderOptions,
  WanderWhen,
} from './types'

export const DEFAULT_WANDER: RoamerWanderOptions = {
  enabled: true,
  when: 'idle-only',
  speedPxPerSec: 80,
  pauseMinMs: 4000,
  pauseMaxMs: 15000,
}

export const DEFAULT_IDLE: RoamerIdleOptions = {
  enabled: true,
  actions: { doze: true, lookAround: true, sway: true, shake: true },
  minIntervalMs: 25000,
  maxIntervalMs: 70000,
}

export const DEFAULT_MISCHIEF: RoamerMischiefOptions = {
  enabled: true,
  // Conservative debut: only the two calm actions; dash/peek stay opt-in.
  actions: { pullWindow: true, stickyNote: true, dashAcross: false, edgePeek: false },
  minIntervalMs: 480000,
  maxIntervalMs: 1500000,
  pullLingerMs: 25000,
  noteLingerMs: 45000,
}

const IDLE_ACTION_IDS: readonly IdleActionId[] = ['doze', 'lookAround', 'sway', 'shake']
const MISCHIEF_ACTION_IDS: readonly MischiefActionId[] = ['pullWindow', 'stickyNote', 'dashAcross', 'edgePeek']

/** Every pose-override key the normalizer accepts (types.PoseOverrideKey). */
const POSE_OVERRIDE_KEYS = [
  'walk',
  'dash',
  'doze',
  'lookAround',
  'sway',
  'shake',
  'peek',
  'pull',
  'note',
] as const

const asBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** Ordered pair guard: swap when inverted so random(min,max) never breaks. */
const orderedPair = (min: number, max: number): { min: number; max: number } =>
  min <= max ? { min, max } : { min: max, max: min }

const asWhen = (value: unknown): WanderWhen => (value === 'always' ? 'always' : 'idle-only')

function normalizeWander(raw: unknown): RoamerWanderOptions {
  const bag = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const pause = orderedPair(
    clampNumber(bag.pauseMinMs, DEFAULT_WANDER.pauseMinMs, 0, 600000),
    clampNumber(bag.pauseMaxMs, DEFAULT_WANDER.pauseMaxMs, 0, 600000),
  )
  return {
    enabled: asBool(bag.enabled, DEFAULT_WANDER.enabled),
    when: asWhen(bag.when),
    speedPxPerSec: clampNumber(bag.speedPxPerSec, DEFAULT_WANDER.speedPxPerSec, 5, 600),
    pauseMinMs: pause.min,
    pauseMaxMs: pause.max,
  }
}

function normalizeIdle(raw: unknown): RoamerIdleOptions {
  const bag = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const actionsBag = (typeof bag.actions === 'object' && bag.actions !== null ? bag.actions : {}) as Record<string, unknown>
  const actions = {} as RoamerIdleOptions['actions']
  for (const id of IDLE_ACTION_IDS) actions[id] = asBool(actionsBag[id], DEFAULT_IDLE.actions[id])
  const interval = orderedPair(
    clampNumber(bag.minIntervalMs, DEFAULT_IDLE.minIntervalMs, 1000, 3600000),
    clampNumber(bag.maxIntervalMs, DEFAULT_IDLE.maxIntervalMs, 1000, 3600000),
  )
  return {
    enabled: asBool(bag.enabled, DEFAULT_IDLE.enabled),
    actions,
    minIntervalMs: interval.min,
    maxIntervalMs: interval.max,
  }
}

function normalizeMischief(raw: unknown): RoamerMischiefOptions {
  const bag = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const actionsBag = (typeof bag.actions === 'object' && bag.actions !== null ? bag.actions : {}) as Record<string, unknown>
  const actions = {} as RoamerMischiefOptions['actions']
  for (const id of MISCHIEF_ACTION_IDS) actions[id] = asBool(actionsBag[id], DEFAULT_MISCHIEF.actions[id])
  const interval = orderedPair(
    clampNumber(bag.minIntervalMs, DEFAULT_MISCHIEF.minIntervalMs, 5000, 7200000),
    clampNumber(bag.maxIntervalMs, DEFAULT_MISCHIEF.maxIntervalMs, 5000, 7200000),
  )
  return {
    enabled: asBool(bag.enabled, DEFAULT_MISCHIEF.enabled),
    actions,
    minIntervalMs: interval.min,
    maxIntervalMs: interval.max,
    // User-facing range 0.5s..60s (settings card shows seconds).
    pullLingerMs: clampNumber(bag.pullLingerMs, DEFAULT_MISCHIEF.pullLingerMs, 500, 60000),
    noteLingerMs: clampNumber(bag.noteLingerMs, DEFAULT_MISCHIEF.noteLingerMs, 500, 60000),
  }
}

/** Asset URLs are root-relative petween-asset paths by construction; a hand-
 *  edited settings file carrying anything else (absolute http(s), file://…)
 *  would make the overlay renderer fetch remote content — drop those. */
function isLocalAssetUrl(url: string): boolean {
  return /^\/petween-assets\/[A-Za-z0-9._-]+$/.test(url)
}

function normalizeContentPool(raw: unknown): RoamerContentItem[] {
  if (!Array.isArray(raw)) return []
  const items: RoamerContentItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const bag = entry as Record<string, unknown>
    const id = typeof bag.id === 'string' && bag.id !== '' ? bag.id : `item-${items.length}-${Date.now()}`
    const caption = typeof bag.caption === 'string' && bag.caption !== '' ? bag.caption : undefined
    if (bag.kind === 'image' && typeof bag.url === 'string' && isLocalAssetUrl(bag.url)) {
      items.push({ id, kind: 'image', url: bag.url, caption })
      continue
    }
    if (bag.kind === 'text' && typeof bag.text === 'string' && bag.text.trim() !== '') {
      items.push({ id, kind: 'text', text: bag.text, caption })
    }
    // Anything else (missing url/text, unknown kind, non-local asset url) is
    // dropped silently.
  }
  return items
}

export function normalizeRoamerOptions(raw: unknown): RoamerOptions {
  const bag = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const posesBag = (typeof bag.poses === 'object' && bag.poses !== null ? bag.poses : {}) as Record<string, unknown>
  const poses: RoamerOptions['poses'] = {}
  for (const key of POSE_OVERRIDE_KEYS) {
    // Pose override URLs face the same local-asset rule as pool images.
    if (typeof posesBag[key] === 'string' && isLocalAssetUrl(posesBag[key])) poses[key] = posesBag[key]
  }
  return {
    wander: normalizeWander(bag.wander),
    idle: normalizeIdle(bag.idle),
    mischief: normalizeMischief(bag.mischief),
    contentPool: normalizeContentPool(bag.contentPool),
    poses,
  }
}
