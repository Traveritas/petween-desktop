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

/** Stored under desktop-settings companions.options['stats-hud']. */
export interface StatsHudOptions extends HudOptions {
  styleId?: string
  replyStyleId?: string
  turnStyleId?: string
  enterAnimationId?: string
  exitAnimationId?: string
  dialogue?: boolean
  milestoneAnimationId?: string
  /** Border-to-border gap between columns (px). */
  columnGapPx?: number
}

const STATS_POLL_MS = 400
const TIMER_TICK_MS = 250
const SETTINGS_POLL_MS = 3000
const TURN_HOLD_MS = 4000
const REPLY_HOLD_MS = 7000
const MILESTONE_ANIMATION_DEFAULT = 'builtin:click-pop'
const MILESTONE_THROTTLE_MS = 10_000
const DIALOGUE_RETRIES = 3
const DIALOGUE_RETRY_MS = 700

const clampMin = (value: unknown, fallback: number, min: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, value) : fallback

const asId = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

function normalizeOptions(raw: unknown): StatsHudOptions {
  const bag = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    styleId: asId(bag.styleId),
    replyStyleId: asId(bag.replyStyleId),
    turnStyleId: asId(bag.turnStyleId),
    enterAnimationId: asId(bag.enterAnimationId),
    exitAnimationId: asId(bag.exitAnimationId),
    dialogue: typeof bag.dialogue === 'boolean' ? bag.dialogue : true,
    milestoneAnimationId: asId(bag.milestoneAnimationId) ?? MILESTONE_ANIMATION_DEFAULT,
    columnGapPx: clampMin(bag.columnGapPx, 24, 0),
    multiSession: typeof bag.multiSession === 'boolean' ? bag.multiSession : true,
    turnSummary: typeof bag.turnSummary === 'boolean' ? bag.turnSummary : true,
    milestoneEveryLines: clampMin(bag.milestoneEveryLines, 0, 0),
    thinkingShowThresholdMs: clampMin(bag.thinkingShowThresholdMs, DEFAULT_HUD_OPTIONS.thinkingShowThresholdMs, 0),
    thinkingHoldMs: clampMin(bag.thinkingHoldMs, DEFAULT_HUD_OPTIONS.thinkingHoldMs, 0),
    editHoldMs: clampMin(bag.editHoldMs, DEFAULT_HUD_OPTIONS.editHoldMs, 0),
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

      const spawnHeld = (
        key: string,
        sessionId: string,
        content: Parameters<BubbleHandle['update']>[0],
        holdMs: number,
        placement: 'column' | 'left' | 'below' = 'column',
        styleId?: string,
      ): void => {
        const handle = host.spawn({
          key,
          sessionKey: sessionId,
          placement,
          styleId: styleId ?? options.styleId,
          enterAnimationId: options.enterAnimationId,
          exitAnimationId: options.exitAnimationId,
          content,
        })
        if (holdMs > 0) {
          later(() => handle.close(), holdMs)
        }
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
              spawnHeld(keyOf.reply(sessionId, preview.turnId ?? String(Date.now())), sessionId, { kind: 'reply', sessionId, text: preview.text }, REPLY_HOLD_MS, 'left', options.replyStyleId)
            })
            .catch(() => {})
        }
        attempt(DIALOGUE_RETRIES)
      }

      const execute = (command: HudCommand): void => {
        switch (command.type) {
          case 'thinking-show': {
            const key = keyOf.thinking(command.sessionId)
            const handle = host.spawn({
              key,
              sessionKey: command.sessionId,
              styleId: options.styleId,
              enterAnimationId: options.enterAnimationId,
              exitAnimationId: options.exitAnimationId,
              content: { kind: 'thinking', sessionId: command.sessionId, startedAt: command.startedAt },
            })
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
              host.spawn({
                key,
                sessionKey: command.sessionId,
                styleId: options.styleId,
                enterAnimationId: options.enterAnimationId,
                exitAnimationId: options.exitAnimationId,
                content: { kind: 'edit', sessionId: command.sessionId, added: command.added, removed: command.removed, files: command.files },
              }),
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
            spawnHeld(
              keyOf.turn(command.sessionId, command.turnId),
              command.sessionId,
              {
                kind: 'turn',
                sessionId: command.sessionId,
                thinkingMs: command.thinkingMs,
                linesAdded: command.linesAdded,
                linesRemoved: command.linesRemoved,
                edits: command.edits,
                durationMs: command.durationMs,
              },
              TURN_HOLD_MS,
              'below',
              options.turnStyleId,
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
            // Unknown registry ids fall back to the default skin silently.
            for (const key of ['styleId', 'replyStyleId', 'turnStyleId'] as const) {
              const id = next[key]
              if (id !== undefined && !listBubbleStyles().some((style) => style.id === id)) next[key] = undefined
            }
            if (next.enterAnimationId !== undefined && !listBubbleEnterAnimations().some((animation) => animation.id === next.enterAnimationId)) {
              next.enterAnimationId = undefined
            }
            if (next.exitAnimationId !== undefined && !listBubbleExitAnimations().some((animation) => animation.id === next.exitAnimationId)) {
              next.exitAnimationId = undefined
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
