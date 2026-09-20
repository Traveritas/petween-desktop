/**
 * roamer/types.ts — shared shapes for the autonomous-behavior companion
 * (docs/05 Phase 17): the option bag stored under
 * desktop-settings companions.options['roamer'], plus the pure engine's
 * event/command vocabulary. Pure data — imported by the engine (node
 * tests), the overlay runtime, the settings card and the host assembly.
 *
 * Migration discipline (same line as the connector plugin-ization call):
 * this directory is written self-contained against the petween/client
 * extension surface ONLY (types + runtime calls, no shell imports), so a
 * future dual-host split follows the petween-physics precedent — move the
 * directory, mirror the DesktopCompanion shape, swap the options bag for a
 * config hub.
 */
import type { StageSnapshot } from 'petween/client/extension-service'

export const ROAMER_ID = 'roamer'

export type WanderWhen = 'idle-only' | 'always'

export interface RoamerWanderOptions {
  enabled: boolean
  when: WanderWhen
  /** Constant walk speed; leg duration = distance / speed. */
  speedPxPerSec: number
  /** Rest between legs, randomized in [min, max]. */
  pauseMinMs: number
  pauseMaxMs: number
}

/** Idle micro-actions (batch 2): scheduled while the pet is stationary. */
export type IdleActionId = 'doze' | 'lookAround' | 'sway' | 'shake'

export interface RoamerIdleOptions {
  enabled: boolean
  actions: Record<IdleActionId, boolean>
  minIntervalMs: number
  maxIntervalMs: number
}

/** Mischief actions (batch 3/4): pullWindow and stickyNote ship with the DOM layer. */
export type MischiefActionId = 'pullWindow' | 'stickyNote' | 'dashAcross' | 'edgePeek'

export interface RoamerMischiefOptions {
  enabled: boolean
  actions: Record<MischiefActionId, boolean>
  minIntervalMs: number
  maxIntervalMs: number
}

export interface RoamerContentItem {
  id: string
  kind: 'image' | 'text'
  /** Asset URL (/petween-assets/<id>) for kind 'image'. */
  url?: string
  text?: string
  caption?: string
}

/**
 * Per-behavior pose overrides (user-uploaded art of THEIR pet, stored as
 * asset URLs). Empty = the motion-only default (no image swap), because
 * plugin-shipped generic art would clash with user pet packages.
 */
export type PoseOverrideKey = 'walk' | 'doze' | 'lookAround'

export interface RoamerOptions {
  wander: RoamerWanderOptions
  idle: RoamerIdleOptions
  mischief: RoamerMischiefOptions
  contentPool: RoamerContentItem[]
  poses: Partial<Record<PoseOverrideKey, string>>
}

/**
 * Everything the runtime feeds the engine. The engine never touches rAF,
 * timers or the service — it converts these into RoamerCommands; the
 * runtime (companion.ts) owns the mechanics (lease, frames, visuals).
 */
export type RoamerEvent =
  | { type: 'stage'; snapshot: StageSnapshot | null }
  | { type: 'tick'; now: number }
  | { type: 'drag'; phase: 'start' | 'end'; now: number }
  | { type: 'leg-complete'; now: number }
  | { type: 'lease-denied'; now: number }
  | { type: 'hidden'; now: number }

export interface Point {
  x: number
  y: number
}

export interface WanderLegPlan {
  from: Point
  to: Point
  durationMs: number
}

/** Which screen edge a pulled window slides in from. */
export type PullEdge = 'left' | 'right'

export type RoamerCommand =
  | ({ type: 'wander-start' } & WanderLegPlan)
  /**
   * Stop the current leg. commit=true persists the position (leg completed
   * / settled while hidden); commit=false drops the leg where it stands
   * (user grabbed the pet, lease lost, session gone).
   */
  | { type: 'wander-end'; commit: boolean }
  /**
   * Play an idle micro-action: the default motion animation plus the
   * optional pose override for its duration. Occupies the pet (no walk,
   * no other action) until the engine reports idle-action-end or the
   * duration elapses (self-completing on a later tick).
   */
  | { type: 'idle-action-start'; action: IdleActionId; durationMs: number }
  /** Cancel/settle an in-flight idle action (restore any active flash). */
  | { type: 'idle-action-end' }
  /**
   * Drop mischief content onto the desktop: a pulled window sliding in
   * from `edge` anchored near the pet, or a sticky note at a random spot.
   */
  | { type: 'spawn-window'; kind: 'pull' | 'note'; edge?: PullEdge; content: RoamerContentItem }
  /**
   * The pet arrived at `edge` for a peek — play the lean-past-edge motion
   * (batch 4). The engine occupies the pet for PEEK_DURATION_MS.
   */
  | { type: 'peek-start'; edge: PullEdge }
