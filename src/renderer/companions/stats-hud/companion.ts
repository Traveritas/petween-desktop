/**
 * stats-hud/companion.ts — the stats bubble HUD (Phase 10): thinking time
 * and edit line counts as bubbles floating beside the pet. Data path is the
 * SIDE CHANNEL decided in docs/05 Phase 10 — polls /api/petween-desktop/
 * stats (the main-side ledger fed by the zcode connector), never the petween
 * state envelope, so petween stays untouched.
 *
 * Cadence: stats 400ms (bubbles are second-granular; the thinking timer
 * ticks locally at 250ms between polls from thinkingSince), settings 3s
 * (style/animation picks), stage snapshots drive the anchor (bodyRect).
 * The whole subtree is pointer-events:none — click-through is not affected.
 */
import type { ComponentType } from 'react'
import type { DesktopCompanion, DesktopCompanionContext } from '../registry'
import type { StatsSnapshot } from '../../../main/connectors/stats-ledger'
import { createBubbleHost, type BubbleHandle } from '../bubbles/bubble-host'
import { formatDuration, listBubbleStyles } from '../bubbles/styles'
import {
  LEGACY_BUNDLED_EXITS,
  listBubbleEnterAnimations,
  listBubbleExitAnimations,
} from '../bubbles/animations'
import { createHudReducer, DEFAULT_HUD_OPTIONS, type HudCommand, type HudOptions } from './hud-logic'
import { StatsHudCard } from './settings-card'

export const STATS_HUD_ID = 'stats-hud'

/** Stored under desktop-settings companions.options['stats-hud']. */
export interface StatsHudOptions extends HudOptions {
  styleId?: string
  enterAnimationId?: string
  exitAnimationId?: string
}

const STATS_POLL_MS = 400
const TIMER_TICK_MS = 250
const SETTINGS_POLL_MS = 3000

const clampMin = (value: unknown, fallback: number, min: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, value) : fallback

function normalizeOptions(raw: unknown): StatsHudOptions {
  const bag = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const asId = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
  const options: StatsHudOptions = {
    styleId: asId(bag.styleId),
    enterAnimationId: asId(bag.enterAnimationId),
    exitAnimationId: asId(bag.exitAnimationId),
    thinkingShowThresholdMs: clampMin(bag.thinkingShowThresholdMs, DEFAULT_HUD_OPTIONS.thinkingShowThresholdMs, 0),
    thinkingHoldMs: clampMin(bag.thinkingHoldMs, DEFAULT_HUD_OPTIONS.thinkingHoldMs, 0),
    editHoldMs: clampMin(bag.editHoldMs, DEFAULT_HUD_OPTIONS.editHoldMs, 0),
    editMaxAgeMs: clampMin(bag.editMaxAgeMs, DEFAULT_HUD_OPTIONS.editMaxAgeMs, 0),
  }
  // v0.2.3 stored one bundled `animationId`; migrate it to the same look.
  const legacy = asId(bag.animationId)
  if (legacy !== undefined) {
    if (options.enterAnimationId === undefined) options.enterAnimationId = legacy
    if (options.exitAnimationId === undefined) options.exitAnimationId = LEGACY_BUNDLED_EXITS[legacy]
  }
  return options
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
    description: '思考用时与文件写入行数以泡泡形式悬浮在宠物旁，随写入实时累加，完成后淡出。数据来自 zcode 连接器。',
    SettingsCard: StatsHudCard as ComponentType,
    init({ petween }: DesktopCompanionContext) {
      let options: StatsHudOptions = normalizeOptions(undefined)
      let disposed = false
      let cursor = 0
      // ONE reducer instance: it owns per-session episode tracking across
      // polls; option changes flow in through the getter, not a rebuild.
      const reducer = createHudReducer(() => options)
      let box: { x: number; y: number; width: number; height: number } | null = null
      let thinking: LiveThinking | null = null
      let editHandle: BubbleHandle | null = null
      const pendingCloses = new Map<string, ReturnType<typeof setTimeout>>()
      const timers = new Set<ReturnType<typeof setTimeout>>()

      const host = createBubbleHost({
        anchor: () => box,
        viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
      })

      const keyOf = { thinking: (sessionId: string): string => `thinking:${sessionId}`, edit: (sessionId: string): string => `edit:${sessionId}` }

      const cancelPendingClose = (key: string): void => {
        const timer = pendingCloses.get(key)
        if (timer !== undefined) {
          clearTimeout(timer)
          pendingCloses.delete(key)
        }
      }

      const later = (fn: () => void, delayMs: number): void => {
        const timer = setTimeout(() => {
          timers.delete(timer)
          fn()
        }, delayMs)
        timers.add(timer)
      }

      const styleId = (): string | undefined => options.styleId
      const enterAnimationId = (): string | undefined => options.enterAnimationId
      const exitAnimationId = (): string | undefined => options.exitAnimationId

      const execute = (command: HudCommand): void => {
        switch (command.type) {
          case 'thinking-show': {
            const key = keyOf.thinking(command.sessionId)
            cancelPendingClose(key)
            const handle = host.spawn({
              key,
              styleId: styleId(),
              enterAnimationId: enterAnimationId(),
              exitAnimationId: exitAnimationId(),
              content: { kind: 'thinking', sessionId: command.sessionId, startedAt: command.startedAt },
            })
            thinking = { handle, startedAt: command.startedAt, finalMs: null }
            break
          }
          case 'thinking-hide': {
            const key = keyOf.thinking(command.sessionId)
            const live = thinking
            if (live === null || live.handle.key !== key) break
            live.finalMs = command.totalMs
            const timerNode = live.handle.el.querySelector<HTMLElement>('.pt-bubble__timer')
            if (timerNode !== null) timerNode.textContent = formatDuration(command.totalMs)
            cancelPendingClose(key)
            later(() => {
              live.handle.close()
              if (thinking === live) thinking = null
            }, command.holdMs)
            break
          }
          case 'edit-show': {
            const key = keyOf.edit(command.sessionId)
            cancelPendingClose(key)
            editHandle = host.spawn({
              key,
              styleId: styleId(),
              enterAnimationId: enterAnimationId(),
              exitAnimationId: exitAnimationId(),
              content: { kind: 'edit', sessionId: command.sessionId, added: command.added, removed: command.removed, files: command.files },
            })
            break
          }
          case 'edit-update': {
            const key = keyOf.edit(command.sessionId)
            const handle = editHandle ?? host.find(key)
            if (handle === null) break
            editHandle = handle
            handle.update(
              { kind: 'edit', sessionId: command.sessionId, added: command.added, removed: command.removed, files: command.files },
              { bump: true },
            )
            break
          }
          case 'edit-hide': {
            const key = keyOf.edit(command.sessionId)
            const handle = editHandle ?? host.find(key)
            if (handle === null) break
            cancelPendingClose(key)
            later(() => {
              handle.close()
              if (editHandle === handle) editHandle = null
            }, command.holdMs)
            break
          }
        }
      }

      const tickTimer = (): void => {
        const live = thinking
        if (live === null || live.finalMs !== null || live.handle.closed) return
        const node = live.handle.el.querySelector<HTMLElement>('.pt-bubble__timer')
        if (node !== null) node.textContent = formatDuration(Date.now() - live.startedAt)
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
            for (const command of reducer.apply(snapshot, Date.now())) execute(command)
          })
          .catch(() => {})
      }
      const statsTimer = setInterval(pollStats, STATS_POLL_MS)
      const tickTimerId = setInterval(tickTimer, TIMER_TICK_MS)

      const pullOptions = (): void => {
        if (disposed) return
        void fetch('/api/petween-desktop/settings')
          .then((response) => (response.ok ? response.json() : null))
          .then((body: { settings?: { companions?: { options?: Record<string, unknown> } } } | null) => {
            if (disposed || body === null) return
            const next = normalizeOptions(body.settings?.companions?.options?.[STATS_HUD_ID])
            // Unknown registry ids fall back to the default skin silently.
            if (next.styleId !== undefined && !listBubbleStyles().some((style) => style.id === next.styleId)) {
              next.styleId = undefined
            }
            if (next.enterAnimationId !== undefined && !listBubbleEnterAnimations().some((animation) => animation.id === next.enterAnimationId)) {
              next.enterAnimationId = undefined
            }
            if (next.exitAnimationId !== undefined && !listBubbleExitAnimations().some((animation) => animation.id === next.exitAnimationId)) {
              next.exitAnimationId = undefined
            }
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
        for (const timer of pendingCloses.values()) clearTimeout(timer)
        pendingCloses.clear()
        unsubscribeStage()
        host.dispose()
        thinking = null
        editHandle = null
      }
    },
  }
}
