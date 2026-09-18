/**
 * stats-hud/hud-logic.ts — the pure bubble state machine (Phase 10). Turns a
 * stats snapshot stream (main-side ledger, docs/05 Phase 10) into spawn/
 * update/hide commands for the DOM side; every timing policy lives here so
 * it is unit-testable without a DOM:
 *
 * - Thinking bubble: appears only after the session has been thinking for
 *   `thinkingShowThresholdMs` (below that it's flicker between fast tools),
 *   ticks live from thinkingSince, hides when the state leaves thinking.
 * - Edit bubble: one per WORKING EPISODE — the first edit fact of an episode
 *   spawns it, subsequent edit facts accumulate into it live (the "写入过程
 *   行数实时更新" effect), and leaving working hides it (the companion adds
 *   the hold delay so the final total stays readable).
 * - v1 scope: the focused session only (follow target / last active). A focus
 *   switch immediately hides the previous session's live bubbles.
 */

import type { StatsSnapshot, StatsLedgerEvent } from '../../../main/connectors/stats-ledger'

export interface HudOptions {
  /** Thinking shorter than this never shows a bubble (ms). */
  thinkingShowThresholdMs: number
  /** How long the final thinking total stays before the fade (ms). */
  thinkingHoldMs: number
  /** How long a finished edit episode stays before the fade (ms). */
  editHoldMs: number
  /** Hard cap for one edit bubble's life (ms) — runaway working episodes. */
  editMaxAgeMs: number
}

export const DEFAULT_HUD_OPTIONS: HudOptions = {
  thinkingShowThresholdMs: 1500,
  thinkingHoldMs: 900,
  editHoldMs: 1500,
  editMaxAgeMs: 20_000,
}

export type HudCommand =
  | { type: 'thinking-show'; sessionId: string; startedAt: number }
  | { type: 'thinking-hide'; sessionId: string; totalMs: number; holdMs: number }
  | { type: 'edit-show'; sessionId: string; added: number | null; removed: number | null; files: number }
  | { type: 'edit-update'; sessionId: string; added: number | null; removed: number | null; files: number }
  | { type: 'edit-hide'; sessionId: string; holdMs: number; maxAgeReached: boolean }

interface EditEpisode {
  added: number
  removed: number
  files: number
  startedAt: number
}

interface SessionTrack {
  thinkingShown: boolean
  /** Current thinking interval's start (event time), when known. */
  thinkingIntervalStart: number | null
  editEpisode: EditEpisode | null
}

export interface HudReducer {
  /** Process one snapshot; commands are in causal order. */
  apply(snapshot: StatsSnapshot, now: number): HudCommand[]
}

/**
 * `getOptions` is read on every apply so live setting changes take effect
 * without rebuilding (and resetting) the reducer's per-session tracking. A
 * plain options object is accepted too (frozen at creation).
 */
export function createHudReducer(getOptions?: (() => Partial<HudOptions>) | Partial<HudOptions>): HudReducer {
  const resolveOptions = (): Partial<HudOptions> | undefined =>
    typeof getOptions === 'function' ? getOptions() : getOptions
  const options = (): HudOptions => ({ ...DEFAULT_HUD_OPTIONS, ...(resolveOptions() ?? {}) })
  const tracks = new Map<string, SessionTrack>()
  let lastFocus: string | null = null

  const trackOf = (sessionId: string): SessionTrack => {
    let track = tracks.get(sessionId)
    if (track === undefined) {
      track = { thinkingShown: false, thinkingIntervalStart: null, editEpisode: null }
      tracks.set(sessionId, track)
    }
    return track
  }

  const hideEdit = (commands: HudCommand[], sessionId: string, holdMs: number, maxAgeReached: boolean, track: SessionTrack): void => {
    if (track.editEpisode === null) return
    track.editEpisode = null
    commands.push({ type: 'edit-hide', sessionId, holdMs, maxAgeReached })
  }

  const applyEvent = (commands: HudCommand[], event: StatsLedgerEvent, focus: string): void => {
    const track = trackOf(focus)
    if (event.type === 'state') {
      if (event.state === 'thinking') {
        if (track.thinkingIntervalStart === null) track.thinkingIntervalStart = event.at
      } else {
        if (track.thinkingIntervalStart !== null && track.thinkingShown) {
          commands.push({
            type: 'thinking-hide',
            sessionId: focus,
            totalMs: Math.max(0, event.at - track.thinkingIntervalStart),
            holdMs: options().thinkingHoldMs,
          })
        }
        track.thinkingShown = false
        track.thinkingIntervalStart = null
      }
      // Entering thinking IS leaving working: the episode's bubble hides too.
      if (event.state !== 'working') {
        hideEdit(commands, focus, options().editHoldMs, false, track)
      }
      return
    }
    // Edit fact: open or grow the working episode's bubble.
    const added = event.added ?? null
    const removed = event.removed ?? null
    if (track.editEpisode === null) {
      track.editEpisode = { added: added ?? 0, removed: removed ?? 0, files: 1, startedAt: event.at }
      commands.push({ type: 'edit-show', sessionId: focus, added, removed, files: 1 })
    } else {
      track.editEpisode.added += added ?? 0
      track.editEpisode.removed += removed ?? 0
      track.editEpisode.files += 1
      commands.push({
        type: 'edit-update',
        sessionId: focus,
        added: track.editEpisode.added,
        removed: track.editEpisode.removed,
        files: track.editEpisode.files,
      })
    }
  }

  return {
    apply(snapshot, now) {
      const commands: HudCommand[] = []
      const focus = snapshot.focusedSessionId

      // Focus switched away: retire the old focus's live bubbles at once.
      if (lastFocus !== null && focus !== lastFocus) {
        const previous = tracks.get(lastFocus)
        if (previous !== undefined) {
          if (previous.thinkingShown) {
            previous.thinkingShown = false
            commands.push({ type: 'thinking-hide', sessionId: lastFocus, totalMs: 0, holdMs: 0 })
          }
          hideEdit(commands, lastFocus, 0, false, previous)
          previous.thinkingIntervalStart = null
        }
      }
      lastFocus = focus
      if (focus === null) return commands

      for (const event of snapshot.events) {
        if (event.sessionId === focus) applyEvent(commands, event, focus)
      }

      // Post-replay reconciliation against the live summary: catches the
      // threshold crossing that happens BETWEEN events (the poll-driven
      // timer path) and episodes whose closing event predates the ring.
      const summary = snapshot.sessions[focus]
      const track = trackOf(focus)
      if (summary !== undefined) {
        if (summary.state === 'thinking' && summary.thinkingSince !== null) {
          if (track.thinkingIntervalStart === null) track.thinkingIntervalStart = summary.thinkingSince
          if (!track.thinkingShown && now - summary.thinkingSince >= options().thinkingShowThresholdMs) {
            track.thinkingShown = true
            commands.push({ type: 'thinking-show', sessionId: focus, startedAt: summary.thinkingSince })
          }
        }
        if (summary.state !== 'working') {
          hideEdit(commands, focus, options().editHoldMs, false, track)
        }
      }

      // Hard cap: a working episode older than editMaxAgeMs hides regardless.
      if (track.editEpisode !== null && options().editMaxAgeMs > 0 && now - track.editEpisode.startedAt >= options().editMaxAgeMs) {
        hideEdit(commands, focus, 0, true, track)
      }

      return commands
    },
  }
}
