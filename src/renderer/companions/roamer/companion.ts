/**
 * roamer/companion.ts — the runtime half of the autonomous-behavior
 * companion (docs/05 Phase 17, batch 1: wandering). Interprets the pure
 * engine's commands into mechanics:
 *
 *  - wander-start → acquire the exclusive PositionDriver (null = physics
 *    owns it → feed 'lease-denied' back), run a constant-speed rAF leg,
 *    flash the optional walk pose override, loop the walk-bob animation;
 *  - wander-end   → dispose the animation instance, restore an active
 *    pose flash (flashPose of the CURRENT state slot with a 1ms hold —
 *    the restore trick: it re-resolves and re-shows the state pose), and
 *    release the lease AFTER commit lands (physics endFlight ordering).
 *
 * Interruptions covered: user drag (service-level + driver-level events),
 * window hidden (rAF stops — settle immediately), session teardown, and
 * options polled every 3s (stats-hud pullOptions pattern — no remount).
 */
import type { ComponentType } from 'react'
import type {
  PetweenClientService,
  PositionDriver,
  StageSnapshot,
} from 'petween/client/extension-service'
import type { TimelineInstance } from 'petween/motion/animation-handle'
import type { DesktopCompanion, DesktopCompanionContext } from '../registry'
import { createRoamerEngine } from './engine'
import { normalizeRoamerOptions } from './options'
import { WALK_BOB_ANIMATION_ID } from './animations'
import { ROAMER_ID, type Point, type RoamerCommand, type RoamerEvent, type WanderLegPlan } from './types'
import { RoamerCard } from './settings-card'

const SETTINGS_POLL_MS = 3000
const HEARTBEAT_MS = 1000
/** commit() must precede release(), but never deadlock the lease (physics uses 20s). */
const COMMIT_TIMEOUT_MS = 20000
/** Grace on top of the engine's plan for the runtime's own frame clock. */
const POSE_RESTORE_HOLD_MS = 1

export function createRoamerCompanion(): DesktopCompanion {
  return {
    id: ROAMER_ID,
    displayName: '自主行为（游荡 / 待机 / 捣乱）',
    description:
      '闲时宠物自己在桌面上游荡（可配成永远）；后续批次加入待机小动作与捣乱行为。纯视觉行为，不抢鼠标、不影响点击穿透。',
    SettingsCard: RoamerCard as ComponentType,
    init({ petween }: DesktopCompanionContext) {
      let disposed = false
      let options = normalizeRoamerOptions(undefined)
      let snapshot: StageSnapshot | null = petween.getStageSnapshot()
      const engine = createRoamerEngine({ getOptions: () => options })

      // --- walk runtime state (all null/idle while resting) ---
      let driver: PositionDriver | null = null
      let detachDriverDrag: (() => void) | null = null
      let leg: {
        plan: WanderLegPlan
        from: Point
        cancelFrame: () => void
      } | null = null
      let walkAnim: TimelineInstance | null = null
      let walkFlashActive = false

      const lerp = (from: number, to: number, t: number): number => from + (to - from) * t

      const endWalk = (commit: boolean): void => {
        leg?.cancelFrame()
        leg = null
        if (walkAnim !== null) {
          try {
            walkAnim.dispose()
          } catch {
            /* a disposed stage already took the instance down */
          }
          walkAnim = null
        }
        if (walkFlashActive) {
          // Restore trick: flashing the state machine's CURRENT slot with a
          // 1ms hold re-resolves and re-shows the state pose right away —
          // otherwise an aborted leg would keep the walk image until the
          // original holdMs timer fires.
          walkFlashActive = false
          try {
            petween.flashPose(snapshot?.poseKey ?? 'idle', POSE_RESTORE_HOLD_MS)
          } catch {
            /* the stage may be gone with the session */
          }
        }
        const held = driver
        if (held !== null) {
          driver = null
          detachDriverDrag?.()
          detachDriverDrag = null
          if (commit) {
            void Promise.race([
              held.commit(),
              new Promise<void>((resolve) => setTimeout(resolve, COMMIT_TIMEOUT_MS)),
            ]).then(
              () => held.release(),
              () => held.release(),
            )
          } else {
            held.release()
          }
        }
      }

      const startWalk = (plan: WanderLegPlan): void => {
        const lease = petween.requestPositionControl()
        if (lease === null) {
          pump({ type: 'lease-denied', now: Date.now() })
          return
        }
        driver = lease
        detachDriverDrag = lease.onUserDrag((phase) => pump({ type: 'drag', phase, now: Date.now() }))
        // The live position outranks the engine's plan.from (a stage event
        // may have raced the decision); interpolate from what is true now.
        const from: Point =
          snapshot !== null
            ? { x: snapshot.x, y: snapshot.y }
            : { x: plan.from.x, y: plan.from.y }
        const startedPerf = performance.now()
        // Walk visuals: the bob animation always, the pose override only if
        // the user uploaded one (flashAsset needs no registration).
        walkAnim = petween.playAnimation(WALK_BOB_ANIMATION_ID)
        if (options.poses.walk !== undefined) {
          walkFlashActive = petween.flashAsset({ url: options.poses.walk }, plan.durationMs + 500)
        }
        const step = (): void => {
          const active = leg
          if (active === null || driver === null) return
          const t = (performance.now() - startedPerf) / Math.max(1, active.plan.durationMs)
          if (t >= 1) {
            driver.apply(active.plan.to.x, active.plan.to.y)
            leg = null
            active.cancelFrame()
            pump({ type: 'leg-complete', now: Date.now() })
            return
          }
          driver.apply(
            lerp(active.from.x, active.plan.to.x, t),
            lerp(active.from.y, active.plan.to.y, t),
          )
          const handle = requestAnimationFrame(step)
          active.cancelFrame = () => cancelAnimationFrame(handle)
        }
        const handle = requestAnimationFrame(step)
        leg = { plan, from, cancelFrame: () => cancelAnimationFrame(handle) }
      }

      const execute = (command: RoamerCommand): void => {
        if (command.type === 'wander-start') startWalk(command)
        else endWalk(command.commit)
      }

      const pump = (event: RoamerEvent): void => {
        if (disposed) return
        for (const command of engine.apply(event)) execute(command)
      }

      const unsubscribeStage = petween.subscribeStage((next) => {
        snapshot = next
        pump({ type: 'stage', snapshot: next })
      })
      const unsubscribeDrag = petween.subscribeUserDrag((phase) => pump({ type: 'drag', phase, now: Date.now() }))

      const heartbeat = setInterval(() => pump({ type: 'tick', now: Date.now() }), HEARTBEAT_MS)

      const pullOptions = (): void => {
        if (disposed) return
        void fetch('/api/petween-desktop/settings')
          .then((response) => (response.ok ? response.json() : null))
          .then((body: { settings?: { companions?: { options?: Record<string, unknown> } } } | null) => {
            if (disposed || body === null) return
            options = normalizeRoamerOptions(body.settings?.companions?.options?.[ROAMER_ID])
          })
          .catch(() => {})
      }
      const settingsTimer = setInterval(pullOptions, SETTINGS_POLL_MS)
      pullOptions()

      // §23 (rAF never fires while hidden): settle a mid-flight leg at once.
      const onVisibilityChange = (): void => {
        if (document.hidden) pump({ type: 'hidden', now: Date.now() })
      }
      document.addEventListener('visibilitychange', onVisibilityChange)

      return () => {
        disposed = true
        clearInterval(heartbeat)
        clearInterval(settingsTimer)
        document.removeEventListener('visibilitychange', onVisibilityChange)
        unsubscribeStage()
        unsubscribeDrag()
        endWalk(false)
      }
    },
  }
}
