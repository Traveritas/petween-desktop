/**
 * roamer/animations.ts — the factory-default motion animations, pure JSON
 * (no DOM, no petween imports beyond the type): safe to import from BOTH
 * the overlay renderer (playback by id) and the main-process host assembly
 * (one-time registration), which keeps a single source of truth.
 *
 * WHY `kind: 'interaction'`: every effect here is a deformation that must
 * NOT swap the pose (the pet keeps whatever its state machine shows; pose
 * overrides are flashPose/flashAsset business, separately owned). The
 * petween schema rejects pose-swap events inside `interaction` — exactly
 * the guarantee we want (same reasoning as petween-physics's bounce).
 */
import type { AnimationDefinition } from 'petween/motion/animation-definition'
import type { IdleActionId } from './types'

/** Library ids: `user:<pack>-<name>` convention (pack = this companion). */
export const WALK_BOB_ANIMATION_ID = 'user:roamer-walk-bob'

/**
 * The walking gait: a ~800ms vertical bob with a slight counter-rotation,
 * looping for the leg's duration. Amplitudes stay small on purpose — the
 * POSITION movement carries the walk; this only sells it. Seamless loop:
 * every track's first and last keyframe values match.
 */
export const WALK_BOB_ANIMATION: AnimationDefinition = {
  version: 1,
  id: WALK_BOB_ANIMATION_ID,
  name: 'Roamer Walk Bob',
  kind: 'interaction',
  durationMs: 800,
  repeat: { mode: 'loop' },
  tracks: [
    {
      property: 'transition.y',
      keyframes: [
        { at: 0, value: 0, easing: 'ease-in-out' },
        { at: 0.5, value: -6, easing: 'ease-in-out' },
        { at: 1, value: 0 },
      ],
    },
    {
      property: 'transition.rotation',
      keyframes: [
        { at: 0, value: -1.5, easing: 'ease-in-out' },
        { at: 0.5, value: 1.5, easing: 'ease-in-out' },
        { at: 1, value: -1.5 },
      ],
    },
  ],
}

/**
 * Idle micro-actions (batch 2): all `once` deformations on the transition
 * layer; the optional user pose override (doze/lookAround) rides flashPose
 * on top. Seamless endpoints (first == last keyframe value) throughout.
 */

/** Drowsy head-nod: slow dips that never quite recover. */
export const DOZE_ANIMATION_ID = 'user:roamer-doze'

export const DOZE_ANIMATION: AnimationDefinition = {
  version: 1,
  id: DOZE_ANIMATION_ID,
  name: 'Roamer Doze',
  kind: 'interaction',
  durationMs: 2600,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.y',
      keyframes: [
        { at: 0, value: 0, easing: 'ease-in-out' },
        { at: 0.3, value: 4, easing: 'ease-in-out' },
        { at: 0.45, value: 2, easing: 'ease-in-out' },
        { at: 0.7, value: 6, easing: 'ease-in-out' },
        { at: 0.85, value: 3, easing: 'ease-in-out' },
        { at: 1, value: 0 },
      ],
    },
  ],
}

/** Glance left, hold, glance right, hold, back. */
export const LOOK_AROUND_ANIMATION_ID = 'user:roamer-look-around'

export const LOOK_AROUND_ANIMATION: AnimationDefinition = {
  version: 1,
  id: LOOK_AROUND_ANIMATION_ID,
  name: 'Roamer Look Around',
  kind: 'interaction',
  durationMs: 1800,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.x',
      keyframes: [
        { at: 0, value: 0, easing: 'ease-out' },
        { at: 0.25, value: 9, easing: 'linear' },
        { at: 0.45, value: 9, easing: 'ease-in-out' },
        { at: 0.7, value: -9, easing: 'linear' },
        { at: 0.9, value: -9, easing: 'ease-in-out' },
        { at: 1, value: 0 },
      ],
    },
  ],
}

/** Lazy weight shift. */
export const SWAY_ANIMATION_ID = 'user:roamer-sway'

export const SWAY_ANIMATION: AnimationDefinition = {
  version: 1,
  id: SWAY_ANIMATION_ID,
  name: 'Roamer Sway',
  kind: 'interaction',
  durationMs: 2200,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.rotation',
      keyframes: [
        { at: 0, value: 0, easing: 'ease-in-out' },
        { at: 0.3, value: 3, easing: 'ease-in-out' },
        { at: 0.75, value: -3, easing: 'ease-in-out' },
        { at: 1, value: 0 },
      ],
    },
  ],
}

/** Quick wet-dog shake. */
export const SHAKE_ANIMATION_ID = 'user:roamer-shake'

export const SHAKE_ANIMATION: AnimationDefinition = {
  version: 1,
  id: SHAKE_ANIMATION_ID,
  name: 'Roamer Shake',
  kind: 'interaction',
  durationMs: 700,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.x',
      keyframes: [
        { at: 0, value: 0, easing: 'ease-out' },
        { at: 0.2, value: -5, easing: 'ease-in-out' },
        { at: 0.4, value: 5, easing: 'ease-in-out' },
        { at: 0.6, value: -4, easing: 'ease-in-out' },
        { at: 0.8, value: 4, easing: 'ease-in-out' },
        { at: 1, value: 0 },
      ],
    },
  ],
}

/**
 * Edge peeks (batch 4, strengthened in the feedback pass): the pet leans
 * PAST the screen edge on the motion layer — transition.x is a pure visual
 * offset (the §27 position clamp keeps the stage box ≥32px visible; the
 * lean is what sells the peek). Facing per edge: left peeks lean negative,
 * right positive. Mirroring a user's walk POSE is impossible through the
 * pose channel (zoom validates 0.2..8, no negatives) — peeks lean instead,
 * which needs no pose at all. The double-dip with rotation is what makes
 * the effect READ at a glance (a flat slide was invisible in feedback).
 */
export const PEEK_LEFT_ANIMATION_ID = 'user:roamer-edge-peek-left'
export const PEEK_RIGHT_ANIMATION_ID = 'user:roamer-edge-peek-right'

/** How long the engine occupies the pet for one peek. */
export const PEEK_DURATION_MS = 3200

const peekAnimation = (id: string, name: string, direction: 1 | -1): AnimationDefinition => ({
  version: 1,
  id,
  name,
  kind: 'interaction',
  durationMs: PEEK_DURATION_MS,
  repeat: { mode: 'once' },
  tracks: [
    {
      property: 'transition.x',
      keyframes: [
        { at: 0, value: 0, easing: 'ease-out' },
        { at: 0.2, value: 72 * direction, easing: 'linear' },
        { at: 0.42, value: 18 * direction, easing: 'ease-in-out' },
        { at: 0.68, value: 76 * direction, easing: 'linear' },
        { at: 0.82, value: 76 * direction, easing: 'ease-in-out' },
        { at: 1, value: 0 },
      ],
    },
    {
      property: 'transition.rotation',
      keyframes: [
        { at: 0, value: 0, easing: 'ease-out' },
        { at: 0.2, value: 7 * direction, easing: 'linear' },
        { at: 0.42, value: 2 * direction, easing: 'ease-in-out' },
        { at: 0.68, value: 8 * direction, easing: 'linear' },
        { at: 0.82, value: 8 * direction, easing: 'ease-in-out' },
        { at: 1, value: 0 },
      ],
    },
  ],
})

export const PEEK_LEFT_ANIMATION: AnimationDefinition = peekAnimation(PEEK_LEFT_ANIMATION_ID, 'Roamer Edge Peek Left', -1)
export const PEEK_RIGHT_ANIMATION: AnimationDefinition = peekAnimation(PEEK_RIGHT_ANIMATION_ID, 'Roamer Edge Peek Right', 1)

/**
 * The dash gait (feedback pass): a dash leg must read as a RUN, not a fast
 * walk — forward lean (constant rotation), a faster/deeper bob and a slight
 * horizontal stretch do that without any pose art.
 */
export const DASH_ANIMATION_ID = 'user:roamer-dash'

export const DASH_ANIMATION: AnimationDefinition = {
  version: 1,
  id: DASH_ANIMATION_ID,
  name: 'Roamer Dash',
  kind: 'interaction',
  durationMs: 420,
  repeat: { mode: 'loop' },
  tracks: [
    {
      property: 'transition.y',
      keyframes: [
        { at: 0, value: 0, easing: 'ease-in-out' },
        { at: 0.5, value: -8, easing: 'ease-in-out' },
        { at: 1, value: 0 },
      ],
    },
    {
      property: 'transition.rotation',
      keyframes: [
        { at: 0, value: 7, easing: 'ease-in-out' },
        { at: 0.5, value: 9, easing: 'ease-in-out' },
        { at: 1, value: 7 },
      ],
    },
    {
      property: 'transition.scaleX',
      keyframes: [
        { at: 0, value: 1.05, easing: 'ease-in-out' },
        { at: 0.5, value: 1.09, easing: 'ease-in-out' },
        { at: 1, value: 1.05 },
      ],
    },
  ],
}

/** Everything the host assembly registers once (idempotently). */
export const ROAMER_ANIMATIONS: readonly AnimationDefinition[] = [
  WALK_BOB_ANIMATION,
  DOZE_ANIMATION,
  LOOK_AROUND_ANIMATION,
  SWAY_ANIMATION,
  SHAKE_ANIMATION,
  PEEK_LEFT_ANIMATION,
  PEEK_RIGHT_ANIMATION,
  DASH_ANIMATION,
]

/** Playback id per idle action (every action has a default motion). */
export const IDLE_ACTION_ANIMATION_IDS: Record<IdleActionId, string> = {
  doze: DOZE_ANIMATION_ID,
  lookAround: LOOK_AROUND_ANIMATION_ID,
  sway: SWAY_ANIMATION_ID,
  shake: SHAKE_ANIMATION_ID,
}

/**
 * How long each idle action lasts — the ENGINE's occupancy window AND the
 * runtime's pose-flash hold, one table so they cannot drift apart.
 */
export const IDLE_ACTION_DURATIONS_MS: Record<IdleActionId, number> = {
  doze: 2600,
  lookAround: 1800,
  sway: 2200,
  shake: 700,
}
