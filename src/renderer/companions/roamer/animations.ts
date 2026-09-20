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

/** Everything the host assembly registers once (idempotently). */
export const ROAMER_ANIMATIONS: readonly AnimationDefinition[] = [WALK_BOB_ANIMATION]
