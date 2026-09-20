/**
 * roamer-engine: the pure wander decision state machine (docs/05 Phase 17
 * batch 1). Every gate is exercised — idle-only vs always, toggles, drag,
 * reduced motion, lease denial and retry, session teardown and re-arm,
 * grace force-end — with a deterministic random so leg targets are
 * reproducible. No DOM, no timers, no service.
 */
import { describe, expect, it } from 'vitest'
import type { StageSnapshot } from 'petween/client/extension-service'
import { createRoamerEngine } from '../../src/renderer/companions/roamer/engine'
import {
  DEFAULT_IDLE,
  DEFAULT_WANDER,
  normalizeRoamerOptions,
} from '../../src/renderer/companions/roamer/options'
import { IDLE_ACTION_DURATIONS_MS } from '../../src/renderer/companions/roamer/animations'
import type {
  RoamerCommand,
  RoamerIdleOptions,
  RoamerWanderOptions,
} from '../../src/renderer/companions/roamer/types'

const T0 = 1_000_000

const snap = (overrides: Partial<StageSnapshot> = {}): StageSnapshot => ({
  x: 960,
  y: 540,
  scale: 1,
  stageSize: 128,
  visualState: 'idle',
  activityMode: null,
  started: true,
  viewport: { width: 1920, height: 1080 },
  dragging: false,
  reducedMotion: false,
  poseKey: 'idle',
  bodyRect: null,
  activePetId: 'pet_1',
  ...overrides,
})

/** Engine with default options and random() => 0.5 unless overridden. */
const engineWith = (
  options?: Partial<RoamerWanderOptions>,
  idle?: Partial<RoamerIdleOptions>,
  random: () => number = () => 0.5,
) => {
  const bag = {
    wander: { ...DEFAULT_WANDER, ...options },
    idle: { ...DEFAULT_IDLE, ...idle },
  }
  return createRoamerEngine({ getOptions: () => normalizeRoamerOptions(bag), random })
}

const types = (commands: RoamerCommand[]): string[] => commands.map((command) => command.type)

/** Arms the engine (stage + first tick) and returns the initial-delay deadline. */
const arm = (engine: ReturnType<typeof engineWith>, snapshot: StageSnapshot = snap()): number => {
  engine.apply({ type: 'stage', snapshot })
  engine.apply({ type: 'tick', now: T0 })
  return T0 + 6000
}

const walkStartAt = (engine: ReturnType<typeof engineWith>, at: number): Extract<RoamerCommand, { type: 'wander-start' }> => {
  const commands = engine.apply({ type: 'tick', now: at })
  expect(types(commands)).toEqual(['wander-start'])
  return commands[0] as Extract<RoamerCommand, { type: 'wander-start' }>
}

describe('wander lifecycle', () => {
  it('walks after the initial delay, completes on leg-complete, pauses before the next leg', () => {
    const engine = engineWith()
    const deadline = arm(engine)
    expect(types(engine.apply({ type: 'tick', now: deadline - 1 }))).toEqual([])

    const start = walkStartAt(engine, deadline)
    // random()=0.5 → pause = 4000 + 0.5 * (15000 - 4000) = 9500
    const duration = start.durationMs
    expect(types(engine.apply({ type: 'leg-complete', now: deadline + duration }))).toEqual(['wander-end'])
    expect(engine.apply({ type: 'leg-complete', now: deadline + duration })[0]).toBeUndefined()

    expect(types(engine.apply({ type: 'tick', now: deadline + duration + 9499 }))).toEqual([])
    walkStartAt(engine, deadline + duration + 9500)
  })

  it('plans legs inside the safe band (whole pet on screen, lower-third bias)', () => {
    const engine = engineWith()
    const deadline = arm(engine)
    const start = walkStartAt(engine, deadline)

    const stage = 128
    expect(start.from).toEqual({ x: 960, y: 540 })
    // x ∈ [8, 1920-128-8]; y ∈ [max(0.45*1080, 8), 1080-128-12]
    expect(start.to.x).toBeGreaterThanOrEqual(8)
    expect(start.to.x).toBeLessThanOrEqual(1920 - stage - 8)
    expect(start.to.y).toBeGreaterThanOrEqual(1080 * 0.45)
    expect(start.to.y).toBeLessThanOrEqual(1080 - stage - 12)
    // constant speed: duration = distance / speed
    const distance = Math.hypot(start.to.x - start.from.x, start.to.y - start.from.y)
    expect(start.durationMs).toBeCloseTo((distance / DEFAULT_WANDER.speedPxPerSec) * 1000, 0)
  })

  it('is deterministic for the same random sequence', () => {
    const first = engineWith()
    const second = engineWith()
    const deadlineA = arm(first)
    const deadlineB = arm(second)
    const a = walkStartAt(first, deadlineA)
    const b = walkStartAt(second, deadlineB)
    expect(a.to).toEqual(b.to)
    expect(a.durationMs).toBe(b.durationMs)
  })
})

describe('wander gates', () => {
  it('does not walk while the agent is busy in idle-only mode, but does in always mode', () => {
    const idleOnly = engineWith()
    arm(idleOnly, snap({ visualState: 'thinking', poseKey: 'thinking' }))
    expect(types(idleOnly.apply({ type: 'tick', now: T0 + 60000 }))).toEqual([])

    const always = engineWith({ when: 'always' })
    arm(always, snap({ visualState: 'working', poseKey: 'working' }))
    walkStartAt(always, T0 + 6000)
  })

  it('respects the master toggle, dragging and reduced motion', () => {
    const disabled = engineWith({ enabled: false }, { enabled: false })
    arm(disabled)
    expect(types(disabled.apply({ type: 'tick', now: T0 + 60000 }))).toEqual([])

    const dragged = engineWith()
    arm(dragged, snap({ dragging: true }))
    expect(types(dragged.apply({ type: 'tick', now: T0 + 60000 }))).toEqual([])

    const reduced = engineWith()
    arm(reduced, snap({ reducedMotion: true }))
    expect(types(reduced.apply({ type: 'tick', now: T0 + 60000 }))).toEqual([])
  })

  it('ends an in-flight leg when the agent turns busy (settled, committed)', () => {
    const engine = engineWith()
    const deadline = arm(engine)
    walkStartAt(engine, deadline)
    const commands = engine.apply({ type: 'stage', snapshot: snap({ visualState: 'thinking', poseKey: 'thinking' }) })
    expect(commands).toEqual([{ type: 'wander-end', commit: true }])
  })
})

describe('interruptions', () => {
  it('drops the leg un-committed on user drag start, then rests a full pause after drag end', () => {
    const engine = engineWith()
    const deadline = arm(engine)
    walkStartAt(engine, deadline)

    expect(engine.apply({ type: 'drag', phase: 'start', now: deadline })).toEqual([{ type: 'wander-end', commit: false }])
    expect(types(engine.apply({ type: 'tick', now: deadline + 1000 }))).toEqual([])

    engine.apply({ type: 'drag', phase: 'end', now: deadline + 2000 })
    // pause = 9500 from the drag end
    expect(types(engine.apply({ type: 'tick', now: deadline + 2000 + 9499 }))).toEqual([])
    walkStartAt(engine, deadline + 2000 + 9500)
  })

  it('reschedules on lease denial (physics owns the driver) and retries later', () => {
    const engine = engineWith()
    const deadline = arm(engine)
    walkStartAt(engine, deadline)

    engine.apply({ type: 'lease-denied', now: deadline })
    expect(types(engine.apply({ type: 'tick', now: deadline + 2999 }))).toEqual([])
    walkStartAt(engine, deadline + 3000)
  })

  it('drops everything on session teardown and re-arms with a fresh initial delay on return', () => {
    const engine = engineWith()
    const deadline = arm(engine)
    walkStartAt(engine, deadline)

    expect(engine.apply({ type: 'stage', snapshot: null })).toEqual([{ type: 'wander-end', commit: false }])
    expect(types(engine.apply({ type: 'tick', now: T0 + 60000 }))).toEqual([])

    engine.apply({ type: 'stage', snapshot: snap() })
    engine.apply({ type: 'tick', now: T0 + 61000 })
    expect(types(engine.apply({ type: 'tick', now: T0 + 61000 + 5999 }))).toEqual([])
    walkStartAt(engine, T0 + 61000 + 6000)
  })

  it('settles a mid-flight leg when the window goes hidden', () => {
    const engine = engineWith()
    const deadline = arm(engine)
    walkStartAt(engine, deadline)
    expect(engine.apply({ type: 'hidden', now: deadline + 500 })).toEqual([{ type: 'wander-end', commit: true }])
  })

  it('force-ends a leg whose completion never arrived (grace valve)', () => {
    const engine = engineWith()
    const deadline = arm(engine)
    const start = walkStartAt(engine, deadline)
    const overdue = deadline + start.durationMs * 1.5 + 1
    expect(engine.apply({ type: 'tick', now: overdue })).toEqual([{ type: 'wander-end', commit: false }])
  })
})

describe('idle actions', () => {
  it('fires a random idle action after the interval when stationary (wander off)', () => {
    const engine = engineWith({ enabled: false })
    arm(engine)
    // interval = 25000 + 0.5 * (70000 - 25000) = 47500
    expect(types(engine.apply({ type: 'tick', now: T0 + 47499 }))).toEqual([])
    const commands = engine.apply({ type: 'tick', now: T0 + 47500 })
    expect(types(commands)).toEqual(['idle-action-start'])
    // all four enabled, random()=0.5 → index floor(0.5*4)=2 → sway
    const start = commands[0] as Extract<RoamerCommand, { type: 'idle-action-start' }>
    expect(start.action).toBe('sway')
    expect(start.durationMs).toBe(IDLE_ACTION_DURATIONS_MS.sway)
  })

  it('completes after the duration and reschedules the next interval', () => {
    const engine = engineWith({ enabled: false }, { minIntervalMs: 1000, maxIntervalMs: 1000 })
    arm(engine)
    const start = engine.apply({ type: 'tick', now: T0 + 1000 })[0] as Extract<RoamerCommand, { type: 'idle-action-start' }>
    const end = T0 + 1000 + start.durationMs
    expect(types(engine.apply({ type: 'tick', now: end - 1 }))).toEqual([])
    // completing the action itself emits nothing; the NEXT due fires one interval later
    expect(types(engine.apply({ type: 'tick', now: end }))).toEqual([])
    expect(types(engine.apply({ type: 'tick', now: end + 999 }))).toEqual([])
    expect(types(engine.apply({ type: 'tick', now: end + 1000 }))).toEqual(['idle-action-start'])
  })

  it('respects the master toggle and the per-action toggles', () => {
    const disabled = engineWith({ enabled: false }, { enabled: false })
    arm(disabled)
    expect(types(disabled.apply({ type: 'tick', now: T0 + 100000 }))).toEqual([])

    const shakeOnly = engineWith(
      { enabled: false },
      { actions: { doze: false, lookAround: false, sway: false } },
    )
    arm(shakeOnly)
    const commands = shakeOnly.apply({ type: 'tick', now: T0 + 100000 })
    expect(types(commands)).toEqual(['idle-action-start'])
    expect((commands[0] as Extract<RoamerCommand, { type: 'idle-action-start' }>).action).toBe('shake')
  })

  it('shares the when-mode gate with wander (busy blocks idle-only; always allows)', () => {
    const idleOnly = engineWith({ enabled: false })
    arm(idleOnly, snap({ visualState: 'thinking', poseKey: 'thinking' }))
    expect(types(idleOnly.apply({ type: 'tick', now: T0 + 100000 }))).toEqual([])

    const always = engineWith({ enabled: false, when: 'always' })
    arm(always, snap({ visualState: 'thinking', poseKey: 'thinking' }))
    expect(types(always.apply({ type: 'tick', now: T0 + 100000 }))).toEqual(['idle-action-start'])
  })

  it('does not fire while walking; fires once the leg completed', () => {
    const engine = engineWith(undefined, { minIntervalMs: 7000, maxIntervalMs: 7000 })
    const deadline = arm(engine)
    const start = walkStartAt(engine, deadline)
    // idle due (T0+7000) falls inside the first leg — suppressed
    expect(types(engine.apply({ type: 'tick', now: deadline + 500 }))).toEqual([])
    expect(start.durationMs).toBeGreaterThan(500)

    engine.apply({ type: 'leg-complete', now: deadline + start.durationMs })
    // wander now waits a pause (9500); the overdue idle fires instead
    const commands = engine.apply({ type: 'tick', now: deadline + start.durationMs + 1 })
    expect(types(commands)).toEqual(['idle-action-start'])
  })

  it('cancels on drag start, hidden and session teardown', () => {
    const engine = engineWith({ enabled: false }, { minIntervalMs: 1000, maxIntervalMs: 1000 })
    arm(engine)
    engine.apply({ type: 'tick', now: T0 + 1000 }) // action in flight

    expect(engine.apply({ type: 'drag', phase: 'start', now: T0 + 1200 })).toEqual([{ type: 'idle-action-end' }])
    expect(types(engine.apply({ type: 'tick', now: T0 + 1300 }))).toEqual([]) // still in the gesture

    engine.apply({ type: 'drag', phase: 'end', now: T0 + 1400 }) // reschedules to T0+2400
    expect(types(engine.apply({ type: 'tick', now: T0 + 2399 }))).toEqual([])
    engine.apply({ type: 'tick', now: T0 + 2400 }) // action #2 in flight
    expect(engine.apply({ type: 'hidden', now: T0 + 2600 })).toEqual([{ type: 'idle-action-end' }])

    engine.apply({ type: 'tick', now: T0 + 3600 }) // action #3 in flight
    expect(engine.apply({ type: 'stage', snapshot: null })).toEqual([{ type: 'idle-action-end' }])
  })
})

describe('normalizeRoamerOptions', () => {
  it('fills defaults from garbage input', () => {
    const options = normalizeRoamerOptions('nonsense')
    expect(options.wander).toEqual(DEFAULT_WANDER)
    expect(options.wander.when).toBe('idle-only')
    expect(options.idle.actions.doze).toBe(true)
    expect(options.mischief.actions.dashAcross).toBe(false)
    expect(options.contentPool).toEqual([])
    expect(options.poses.walk).toBeUndefined()
  })

  it('clamps numbers, repairs inverted pairs and keeps valid picks', () => {
    const options = normalizeRoamerOptions({
      wander: { enabled: false, when: 'always', speedPxPerSec: 9999, pauseMinMs: 20000, pauseMaxMs: 1000 },
      contentPool: [
        { id: 'a', kind: 'image', url: '/petween-assets/x' },
        { id: 'b', kind: 'image' }, // missing url → dropped
        { id: 'c', kind: 'text', text: '便签' },
        { id: 'd', kind: 'text', text: '   ' }, // blank → dropped
        'junk',
      ],
      poses: { walk: '/petween-assets/w', doze: '' },
    })
    expect(options.wander.enabled).toBe(false)
    expect(options.wander.when).toBe('always')
    expect(options.wander.speedPxPerSec).toBe(600)
    // inverted pause pair repaired (1000 < 20000)
    expect(options.wander.pauseMinMs).toBeLessThanOrEqual(options.wander.pauseMaxMs)
    expect(options.contentPool).toHaveLength(2)
    expect(options.contentPool[0]).toMatchObject({ id: 'a', kind: 'image' })
    expect(options.poses).toEqual({ walk: '/petween-assets/w' })
  })
})
