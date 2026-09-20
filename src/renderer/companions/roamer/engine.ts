/**
 * roamer/engine.ts — the pure decision state machine (docs/05 Phase 17).
 * Converts RoamerEvents into RoamerCommands; owns NO mechanics (no rAF, no
 * timers, no service calls — the runtime in companion.ts interprets the
 * commands). Same testability contract as stats-hud's createHudReducer:
 * inject a deterministic `random` and every decision is reproducible.
 *
 * Lease discipline lives HERE as decisions and in the runtime as mechanics:
 * the engine only walks one leg at a time (idle actions and mischief never
 * overlap a walk), so the exclusive PositionDriver lease is held exactly
 * while a leg is in flight — petween-physics throws keep their turn, and a
 * denied lease ('lease-denied') simply reschedules the next attempt.
 */
import type { StageSnapshot } from 'petween/client/extension-service'
import type { RoamerCommand, RoamerEvent, RoamerOptions, WanderLegPlan } from './types'

/** Quiet period after the pet first becomes usable — never wander instantly on boot. */
const INITIAL_DELAY_MS = 6000
/** Retry cadence when requestPositionControl() came back null (physics flight owns the lease). */
const LEASE_RETRY_MS = 3000
/** A leg whose completion event never arrived (rAF lost / lease suspended) is force-ended after this factor of its duration. */
const WALK_GRACE_FACTOR = 1.5
const MIN_LEG_MS = 1200
const MAX_LEG_MS = 30000
/** Target margins keep the WHOLE pet on screen (§27 only guarantees 32px). */
const TARGET_MARGIN_PX = 8
const BOTTOM_MARGIN_PX = 12
/** Walk targets bias into the lower band of the screen (pets live near the ground). */
const LOWER_BAND_FROM = 0.45

export interface RoamerEngineDeps {
  getOptions: () => RoamerOptions
  /** Injectable for deterministic tests; defaults to Math.random. */
  random?: () => number
}

interface WalkingMode {
  kind: 'walking'
  leg: WanderLegPlan
  startedAt: number
}

type EngineMode = { kind: 'rest' } | WalkingMode

export interface RoamerEngine {
  apply(event: RoamerEvent): RoamerCommand[]
}

export function createRoamerEngine(deps: RoamerEngineDeps): RoamerEngine {
  const random = deps.random ?? Math.random
  let snapshot: StageSnapshot | null = null
  let mode: EngineMode = { kind: 'rest' }
  /** True once a usable stage snapshot armed the initial-delay countdown. */
  let armed = false
  let pendingArm = false
  let nextWanderAt = Number.POSITIVE_INFINITY

  const between = (min: number, max: number): number => min + (max - min) * random()

  const pauseMs = (options: RoamerOptions): number =>
    between(options.wander.pauseMinMs, options.wander.pauseMaxMs)

  /**
   * Everything that must hold before a NEW leg may start. Mid-walk checks
   * (should the current leg stop early?) use the same gate minus the
   * mode check — see endWalkIfGateClosed.
   */
  const wanderGateOpen = (options: RoamerOptions): boolean => {
    if (snapshot === null || !snapshot.started || snapshot.dragging || snapshot.reducedMotion) return false
    if (!options.wander.enabled) return false
    if (options.wander.when === 'idle-only' && snapshot.visualState !== 'idle') return false
    return true
  }

  /**
   * A walk in flight must yield when the world changed under it: the agent
   * turned busy (idle-only mode), the user's machine asked for reduced
   * motion, or the pet is being dragged. Settling commits — the pet keeps
   * the spot it reached, which is also the natural "stop and listen" pose.
   */
  const walkShouldYield = (options: RoamerOptions): boolean => {
    if (snapshot === null || snapshot.dragging || snapshot.reducedMotion) return true
    if (options.wander.when === 'idle-only' && snapshot.visualState !== 'idle') return true
    return false
  }

  /** Pick the next leg: a random point in the lower band, whole pet on screen. */
  const planLeg = (options: RoamerOptions): WanderLegPlan => {
    const current = snapshot
    const stage = current === null ? 128 : current.stageSize * current.scale
    const viewport = current === null ? { width: 1920, height: 1080 } : current.viewport
    const from = current === null ? { x: viewport.width / 2, y: viewport.height / 2 } : { x: current.x, y: current.y }

    // Degenerate ranges (tiny viewport / huge pet) collapse to the range's
    // clamped edge rather than inverting min>max.
    const xMax = Math.max(TARGET_MARGIN_PX, viewport.width - stage - TARGET_MARGIN_PX)
    const yMin = Math.max(Math.min(viewport.height * LOWER_BAND_FROM, viewport.height - stage - BOTTOM_MARGIN_PX), TARGET_MARGIN_PX)
    const yMax = Math.max(yMin, viewport.height - stage - BOTTOM_MARGIN_PX)
    const to = {
      x: between(TARGET_MARGIN_PX, xMax),
      y: between(yMin, yMax),
    }
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    const durationMs = Math.min(MAX_LEG_MS, Math.max(MIN_LEG_MS, (distance / options.wander.speedPxPerSec) * 1000))
    return { from, to, durationMs }
  }

  const endWalk = (commit: boolean, now: number, commands: RoamerCommand[]): void => {
    if (mode.kind !== 'walking') return
    mode = { kind: 'rest' }
    commands.push({ type: 'wander-end', commit })
    // ALWAYS reschedule from the end moment — a stale nextWanderAt (already
    // in the past for an aborted leg) would fire a new walk on the next tick.
    nextWanderAt = now + pauseMs(deps.getOptions())
  }

  return {
    apply(event: RoamerEvent): RoamerCommand[] {
      const commands: RoamerCommand[] = []
      switch (event.type) {
        case 'stage': {
          snapshot = event.snapshot
          if (event.snapshot === null) {
            // Session gone: drop any leg un-committed and re-arm on return.
            endWalk(false, Date.now(), commands)
            armed = false
            pendingArm = false
            nextWanderAt = Number.POSITIVE_INFINITY
            break
          }
          if (!armed && event.snapshot.started) {
            armed = true
            pendingArm = true
          }
          // Mid-walk world changes end the leg early (settled, committed).
          if (mode.kind === 'walking' && walkShouldYield(deps.getOptions())) {
            endWalk(true, Date.now(), commands)
          }
          break
        }
        case 'tick': {
          const options = deps.getOptions()
          if (pendingArm) {
            pendingArm = false
            nextWanderAt = event.now + INITIAL_DELAY_MS
          }
          if (!armed) break
          if (mode.kind === 'walking') {
            // Safety valve: the runtime's leg-complete should have landed
            // long before the grace window expires.
            const deadline = mode.startedAt + mode.leg.durationMs * WALK_GRACE_FACTOR
            if (event.now > deadline) endWalk(false, event.now, commands)
            break
          }
          if (wanderGateOpen(options) && event.now >= nextWanderAt) {
            const leg = planLeg(options)
            mode = { kind: 'walking', leg, startedAt: event.now }
            commands.push({ type: 'wander-start', ...leg })
          }
          break
        }
        case 'leg-complete': {
          endWalk(true, event.now, commands)
          break
        }
        case 'lease-denied': {
          // The runtime could not acquire the driver (physics owns it);
          // mode was already set to walking optimistically — undo and retry.
          if (mode.kind === 'walking') mode = { kind: 'rest' }
          nextWanderAt = event.now + LEASE_RETRY_MS
          break
        }
        case 'drag': {
          if (event.phase === 'start') {
            // The user's hand outranks the walk; the drag's own end persists.
            endWalk(false, Date.now(), commands)
          } else {
            // After being handled the pet rests a full pause, not the remainder.
            if (armed) nextWanderAt = event.now + pauseMs(deps.getOptions())
          }
          break
        }
        case 'hidden': {
          // rAF never fires while hidden — settle the leg where it stands.
          endWalk(true, event.now, commands)
          break
        }
      }
      return commands
    },
  }
}
