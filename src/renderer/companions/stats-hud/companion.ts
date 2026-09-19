/**
 * stats-hud/companion.ts — the stats bubble HUD (Phase 10): thinking time,
 * edit line counts, turn summaries and reply previews as bubbles floating
 * beside the pet, one column per agent session. Data path is the SIDE
 * CHANNEL (docs/05 Phase 10) — polls /api/petween-desktop/stats (the
 * main-side ledger fed by the zcode connector) plus /dialogue for reply
 * previews — never the petween state envelope, so petween stays untouched.
 *
 * Cadence: stats 400ms (bubbles are second-granular; the thinking timer
 * ticks locally at 250ms between polls from thinkingSince), settings 3s
 * (style/animation picks), stage snapshots drive the anchor (bodyRect).
 * The whole subtree is pointer-events:none — click-through is not affected.
 * The BubbleHost is the shared singleton (dialogue lives in the same columns).
 */
import type { ComponentType } from 'react'
import type { DesktopCompanion, DesktopCompanionContext } from '../registry'
import type { StatsSnapshot } from '../../../main/connectors/stats-ledger'
import { acquireSharedBubbleHost, releaseSharedBubbleHost } from '../bubbles/shared-host'
import type { BubbleHandle } from '../bubbles/bubble-host'
import { formatDuration, listBubbleStyles } from '../bubbles/styles'
import { listBubbleEnterAnimations, listBubbleExitAnimations } from '../bubbles/animations'
import { createHudReducer, DEFAULT_HUD_OPTIONS, type HudCommand, type HudOptions } from './hud-logic'
import { StatsHudCard } from './settings-card'

export const STATS_HUD_ID = 'stats-hud'

/** Per-bubble-type visual config — each of 思考/编辑/回复/完成 skins itself. */
export interface BubbleTypeConfig {
  styleId?: string
  enterAnimationId?: string
  exitAnimationId?: string
  /** How long the finished bubble stays before fading (ms). */
  holdMs?: number
}

export type BubbleTypeKey = 'thinking' | 'edit' | 'reply' | 'turn'

/** Stored under desktop-settings companions.options['stats-hud']. */
export interface StatsHudOptions extends HudOptions {
  types: Record<BubbleTypeKey, BubbleTypeConfig>
  dialogue?: boolean
  milestoneAnimationId?: string
  /** Border-to-border gap between columns (px). */
  columnGapPx?: number
}

export const DEFAULT_HOLDS: Record<BubbleTypeKey, number> = {
  thinking: DEFAULT_HUD_OPTIONS.thinkingHoldMs,
  edit: DEFAULT_HUD_OPTIONS.editHoldMs,
  turn: 4000,
  reply: 7000,
}

const STATS_POLL_MS = 400
const TIMER_TICK_MS = 250
const SETTINGS_POLL_MS = 3000
const MILESTONE_ANIMATION_DEFAULT = 'builtin:click-pop'
const MILESTONE_THROTTLE_MS = 10_000
const DIALOGUE_RETRIES = 3
const DIALOGUE_RETRY_MS = 700

const clampMin = (value: unknown, fallback: number, min: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, value) : fallback

const asId = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

const isBubbleTypeKey = (value: string): value is BubbleTypeKey =>
  value === 'thinking' || value === 'edit' || value === 'reply' || value === 'turn'

/**
 * Migrate the RAW option bag to per-type configs. v0.3.3-and-earlier flat
 * keys map onto the new shape so an existing pick keeps its exact look:
 * styleId → thinking+edit; replyStyleId/turnStyleId → their types; the
 * global animation pair → every type; thinkingHoldMs/editHoldMs → holds.
 */
export function migrateTypeConfigs(raw: unknown): Record<BubbleTypeKey, Required<Pick<BubbleTypeConfig, 'holdMs'>> & BubbleTypeConfig> {
  const bag = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const legacyStyle = asId(bag.styleId)
  const legacyEnter = asId(bag.enterAnimationId)
  const legacyExit = asId(bag.exitAnimationId)
  const legacy = {
    thinking: { styleId: legacyStyle, enterAnimationId: legacyEnter, exitAnimationId: legacyExit, holdMs: clampMin(bag.thinkingHoldMs, DEFAULT_HOLDS.thinking, 0) },
    edit: { styleId: legacyStyle, enterAnimationId: legacyEnter, exitAnimationId: legacyExit, holdMs: clampMin(bag.editHoldMs, DEFAULT_HOLDS.edit, 0) },
    reply: { styleId: asId(bag.replyStyleId), enterAnimationId: legacyEnter, exitAnimationId: legacyExit, holdMs: DEFAULT_HOLDS.reply },
    turn: { styleId: asId(bag.turnStyleId), enterAnimationId: legacyEnter, exitAnimationId: legacyExit, holdMs: DEFAULT_HOLDS.turn },
  }
  const result = { ...legacy }
  const types = (typeof bag.types === 'object' && bag.types !== null ? bag.types : {}) as Record<string, unknown>
  for (const [key, value] of Object.entries(types)) {
    if (!isBubbleTypeKey(key) || typeof value !== 'object' || value === null) continue
    const cfg = value as Record<string, unknown>
    result[key] = {
      styleId: asId(cfg.styleId),
      enterAnimationId: asId(cfg.enterAnimationId),
      exitAnimationId: asId(cfg.exitAnimationId),
      holdMs: clampMin(cfg.holdMs, legacy[key].holdMs, 0),
    }
  }
  return result
}

function normalizeOptions(raw: unknown): StatsHudOptions {
  const bag = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const types = migrateTypeConfigs(raw)
  return {
    types,
    dialogue: typeof bag.dialogue === 'boolean' ? bag.dialogue : true,
    milestoneAnimationId: asId(bag.milestoneAnimationId) ?? MILESTONE_ANIMATION_DEFAULT,
    columnGapPx: clampMin(bag.columnGapPx, 24, 0),
    multiSession: typeof bag.multiSession === 'boolean' ? bag.multiSession : true,
    turnSummary: typeof bag.turnSummary === 'boolean' ? bag.turnSummary : true,
    milestoneEveryLines: clampMin(bag.milestoneEveryLines, 0, 0),
    thinkingShowThresholdMs: clampMin(bag.thinkingShowThresholdMs, DEFAULT_HUD_OPTIONS.thinkingShowThresholdMs, 0),
    // The reducer keeps its flat hold keys; they now source from the types.
    thinkingHoldMs: types.thinking.holdMs,
    editHoldMs: types.edit.holdMs,
    editMaxAgeMs: clampMin(bag.editMaxAgeMs, DEFAULT_HUD_OPTIONS.editMaxAgeMs, 0),
  }
}

interface LiveThinking {
  handle: BubbleHandle
  startedAt: number
  /** Set when hiding: the timer freezes at the final total. */
  finalMs: number | null
}

export function createStatsHudCompanion(): DesktopCompanion {
  return {
    id: STATS_HUD_ID,
    displayName: '统计泡泡（思考 / 编辑行数）',
    description: '思考用时、文件写入行数、回合摘要与模型回复以泡泡形式悬浮在宠物旁（每会话一列）。数据来自 zcode 连接器。',
    SettingsCard: StatsHudCard as ComponentType,
    init({ petween }: DesktopCompanionContext) {
      let options = normalizeOptions(undefined)
      let disposed = false
      let cursor = 0
      // ONE reducer instance: it owns per-session episode tracking across
      // polls; option changes flow in through the getter, not a rebuild.
      const reducer = createHudReducer(() => options)
      let box: { x: number; y: number; width: number; height: number } | null = null
      const thinking = new Map<string, LiveThinking>()
      const editHandles = new Map<string, BubbleHandle>()
      const lastMilestoneAt = new Map<string, number>()
      const timers = new Set<ReturnType<typeof setTimeout>>()

      const host = acquireSharedBubbleHost({
        columnGapPx: options.columnGapPx,
        anchor: () => box,
        viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
      })

      const keyOf = {
        thinking: (sessionId: string): string => `thinking:${sessionId}`,
        edit: (sessionId: string): string => `edit:${sessionId}`,
        turn: (sessionId: string, turnId?: string): string => `turn:${sessionId}:${turnId ?? ''}`,
        reply: (sessionId: string, tag: string): string => `reply:${sessionId}:${tag}`,
      }

      const later = (fn: () => void, delayMs: number): void => {
        const timer = setTimeout(() => {
          timers.delete(timer)
          fn()
        }, delayMs)
        timers.add(timer)
      }

      const spawnWith = (
        key: string,
        sessionId: string,
        type: BubbleTypeKey,
        content: Parameters<BubbleHandle['update']>[0],
        placement: 'column' | 'left' | 'below' = 'column',
        holdOverrideMs?: number,
      ): BubbleHandle => {
        const cfg = options.types[type]
        const handle = host.spawn({
          key,
          sessionKey: sessionId,
          placement,
          styleId: cfg.styleId,
          enterAnimationId: cfg.enterAnimationId,
          exitAnimationId: cfg.exitAnimationId,
          content,
        })
        const hold = holdOverrideMs ?? cfg.holdMs ?? 0
        if (hold > 0) later(() => handle.close(), hold)
        return handle
      }

      /** Reply preview for the just-finished turn; the rollout write may lag
       *  the Stop hook, so retry a couple of times when the turnId mismatches. */
      const pullDialogue = (sessionId: string, turnId: string | undefined): void => {
        if (options.dialogue !== true || disposed) return
        const attempt = (remaining: number): void => {
          if (disposed) return
          void fetch(`/api/petween-desktop/dialogue?session=${encodeURIComponent(sessionId)}`)
            .then((response) => (response.ok ? (response.json() as Promise<{ turnId: string | null; text: string }>) : null))
            .then((preview) => {
              if (disposed || preview === null) return
              const matched = turnId === undefined || preview.turnId === turnId
              if (!matched && remaining > 0) {
                later(() => attempt(remaining - 1), DIALOGUE_RETRY_MS)
                return
              }
              if (preview.text === '') return
              spawnWith(keyOf.reply(sessionId, preview.turnId ?? String(Date.now())), sessionId, 'reply', { kind: 'reply', sessionId, text: preview.text }, 'left')
            })
            .catch(() => {})
        }
        attempt(DIALOGUE_RETRIES)
      }

      const execute = (command: HudCommand): void => {
        switch (command.type) {
          case 'thinking-show': {
            const key = keyOf.thinking(command.sessionId)
            const handle = spawnWith(key, command.sessionId, 'thinking', { kind: 'thinking', sessionId: command.sessionId, startedAt: command.startedAt })
            thinking.set(command.sessionId, { handle, startedAt: command.startedAt, finalMs: null })
            break
          }
          case 'thinking-hide': {
            const live = thinking.get(command.sessionId)
            if (live === undefined) break
            live.finalMs = command.totalMs
            const timerNode = live.handle.el.querySelector<HTMLElement>('.pt-bubble__timer')
            if (timerNode !== null) timerNode.textContent = formatDuration(command.totalMs)
            later(() => {
              live.handle.close()
              if (thinking.get(command.sessionId) === live) thinking.delete(command.sessionId)
            }, command.holdMs)
            break
          }
          case 'edit-show': {
            const key = keyOf.edit(command.sessionId)
            editHandles.set(
              command.sessionId,
              spawnWith(key, command.sessionId, 'edit', { kind: 'edit', sessionId: command.sessionId, added: command.added, removed: command.removed, files: command.files }),
            )
            break
          }
          case 'edit-update': {
            const handle = editHandles.get(command.sessionId) ?? host.find(keyOf.edit(command.sessionId))
            if (handle === null) break
            editHandles.set(command.sessionId, handle)
            handle.update(
              { kind: 'edit', sessionId: command.sessionId, added: command.added, removed: command.removed, files: command.files },
              { bump: true },
            )
            break
          }
          case 'edit-hide': {
            const handle = editHandles.get(command.sessionId) ?? host.find(keyOf.edit(command.sessionId))
            if (handle === null) break
            later(() => {
              handle.close()
              if (editHandles.get(command.sessionId) === handle) editHandles.delete(command.sessionId)
            }, command.holdMs)
            break
          }
          case 'turn-show': {
            spawnWith(
              keyOf.turn(command.sessionId, command.turnId),
              command.sessionId,
              'turn',
              {
                kind: 'turn',
                sessionId: command.sessionId,
                thinkingMs: command.thinkingMs,
                linesAdded: command.linesAdded,
                linesRemoved: command.linesRemoved,
                edits: command.edits,
                durationMs: command.durationMs,
              },
              'below',
            )
            pullDialogue(command.sessionId, command.turnId)
            break
          }
          case 'edit-milestone': {
            const last = lastMilestoneAt.get(command.sessionId) ?? -Infinity
            if (Date.now() - last < MILESTONE_THROTTLE_MS) break
            lastMilestoneAt.set(command.sessionId, Date.now())
            try {
              petween.playAnimation(options.milestoneAnimationId ?? MILESTONE_ANIMATION_DEFAULT)
            } catch {
              /* a companion must never break the host over a pet effect */
            }
            break
          }
        }
      }

      const tickTimers = (): void => {
        const now = Date.now()
        for (const [sessionId, live] of thinking) {
          if (live.finalMs !== null || live.handle.closed) continue
          const node = live.handle.el.querySelector<HTMLElement>('.pt-bubble__timer')
          if (node !== null) node.textContent = formatDuration(now - live.startedAt)
          void sessionId
        }
      }

      // Anchor: the pet's real body box; null while no live pet surface.
      const unsubscribeStage = petween.subscribeStage((snapshot) => {
        box = snapshot?.bodyRect ?? null
        host.relayout()
      })
      box = petween.getStageSnapshot()?.bodyRect ?? null

      const pollStats = (): void => {
        if (disposed) return
        void fetch(`/api/petween-desktop/stats?since=${cursor}`)
          .then((response) => (response.ok ? (response.json() as Promise<StatsSnapshot>) : null))
          .then((snapshot) => {
            if (disposed || snapshot === null) return
            cursor = snapshot.cursor
            host.setFocusSession(snapshot.focusedSessionId)
            for (const command of reducer.apply(snapshot, Date.now())) execute(command)
          })
          .catch(() => {})
      }
      const statsTimer = setInterval(pollStats, STATS_POLL_MS)
      const tickTimerId = setInterval(tickTimers, TIMER_TICK_MS)

      const pullOptions = (): void => {
        if (disposed) return
        void fetch('/api/petween-desktop/settings')
          .then((response) => (response.ok ? response.json() : null))
          .then((body: { settings?: { companions?: { options?: Record<string, unknown> } } } | null) => {
            if (disposed || body === null) return
            const next = normalizeOptions(body.settings?.companions?.options?.[STATS_HUD_ID])
            // Unknown registry ids fall back to defaults silently, per type.
            const styles = listBubbleStyles()
            const enters = listBubbleEnterAnimations()
            const exits = listBubbleExitAnimations()
            for (const cfg of Object.values(next.types)) {
              if (cfg.styleId !== undefined && !styles.some((style) => style.id === cfg.styleId)) cfg.styleId = undefined
              if (cfg.enterAnimationId !== undefined && !enters.some((animation) => animation.id === cfg.enterAnimationId)) cfg.enterAnimationId = undefined
              if (cfg.exitAnimationId !== undefined && !exits.some((animation) => animation.id === cfg.exitAnimationId)) cfg.exitAnimationId = undefined
            }
            host.setColumnGap(next.columnGapPx ?? 24)
            options = next
          })
          .catch(() => {})
      }
      const settingsTimer = setInterval(pullOptions, SETTINGS_POLL_MS)
      pullOptions()
      pollStats()

      return () => {
        disposed = true
        clearInterval(statsTimer)
        clearInterval(tickTimerId)
        clearInterval(settingsTimer)
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
        unsubscribeStage()
        releaseSharedBubbleHost()
        thinking.clear()
        editHandles.clear()
        lastMilestoneAt.clear()
      }
    },
  }
}
