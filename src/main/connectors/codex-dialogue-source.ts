/**
 * connectors/codex-dialogue-source.ts — the OpenAI Codex reply-text source
 * for the dialogue bubble (Phase 16). Codex persists each session as a
 * rollout JSONL at ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl;
 * every hook payload carries its path in `transcript_path`.
 *
 * Rollout shape (spike-verified 2026-09-20 on live files, codex-cli 0.154.0):
 * lines are {timestamp, ordinal, type, payload} with mixed types
 * (session_meta / event_msg / response_item / world_state / turn_context).
 * The reply is served on a platter: `event_msg` with
 * `payload.type === 'task_complete'` carries BOTH `turn_id` AND
 * `last_agent_message` — no chain walking needed (simpler than the CC
 * source). The LAST task_complete with a non-empty message is the reply.
 *
 * Session→file resolution mirrors the CC source: a registry fed by hook
 * payloads (paths validated to live under ~/.codex/sessions — forged
 * payloads must not turn /dialogue into an arbitrary-file oracle), with a
 * recursive suffix scan as fallback (filenames end with the session uuid).
 * Streaming + byte-capped like the siblings. Privacy invariant unchanged.
 */
import { createInterface } from 'node:readline'
import { open, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { truncatePreview } from './dialogue-text'
import type { DialoguePreview, DialogueSource } from './dialogue-source'

const SESSION_ID_PATTERN = /^[\w.-]+$/
const MAX_LINE_BYTES = 4 * 1024 * 1024
export const CODEX_ROLLOUT_MAX_BYTES = 64 * 1024 * 1024
const MAX_PATH_CHARS = 4096

/**
 * Pure: reduce rollout lines to the last completed reply. task_complete
 * carries turn_id + last_agent_message directly (error entries are skipped).
 */
export function extractLastCodexReply(lines: string[]): { turnId: string | null; text: string } | null {
  let best: { turnId: string | null; text: string } | null = null
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.length > MAX_LINE_BYTES) continue
    let line: { type?: unknown; payload?: unknown }
    try {
      line = JSON.parse(trimmed) as { type?: unknown; payload?: unknown }
    } catch {
      continue // the writer may be mid-append
    }
    if (line.type !== 'event_msg') continue
    const payload = line.payload
    if (typeof payload !== 'object' || payload === null) continue
    const record = payload as { type?: unknown; turn_id?: unknown; last_agent_message?: unknown; error?: unknown }
    if (record.type !== 'task_complete') continue
    if (typeof record.last_agent_message !== 'string' || record.last_agent_message.trim() === '') continue
    if (record.error !== null && record.error !== undefined) continue
    best = {
      turnId: typeof record.turn_id === 'string' ? record.turn_id : null,
      text: record.last_agent_message.trim(),
    }
  }
  return best
}

export interface CodexDialogueSource extends DialogueSource {
  /** Feed the session→rollout registry from a hook payload. Cheap; call on every event. */
  noteTranscript(sessionId: string, transcriptPath: string): void
}

export interface CodexDialogueSourceDeps {
  /** ~/.codex — the sessions root under which rollout paths must live. */
  codexDir(): string
  now(): number
  /** Test seam for the total byte cap. */
  maxTotalBytes?: number
}

export function createCodexDialogueSource(deps: CodexDialogueSourceDeps): CodexDialogueSource {
  const rollouts = new Map<string, string>()
  const scanResults = new Map<string, string | null>()
  const byteCap = deps.maxTotalBytes ?? CODEX_ROLLOUT_MAX_BYTES

  const sessionsRoot = (): string => resolve(deps.codexDir(), 'sessions')
  const isSessionsPath = (candidate: string): boolean => {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > MAX_PATH_CHARS) return false
    let absolute: string
    try {
      absolute = resolve(candidate)
    } catch {
      return false
    }
    const root = sessionsRoot()
    return absolute.toLowerCase().startsWith(`${root.toLowerCase()}\\`) || absolute.toLowerCase().startsWith(`${root.toLowerCase()}/`)
  }

  const resolvePath = async (sessionId: string): Promise<string | null> => {
    const known = rollouts.get(sessionId)
    if (known !== undefined) return known
    const scanned = scanResults.get(sessionId)
    if (scanned !== undefined) return scanned
    // One-shot recursive suffix scan: rollout filenames end with the session
    // uuid (-<sessionId>.jsonl). Cached positive and negative — the registry
    // refills from the next hook event anyway.
    let found: string | null = null
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (found !== null || depth > 4) return // sessions/YYYY/MM/DD — four levels max
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (found !== null) return
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), depth + 1)
        } else if (entry.name.endsWith(`-${sessionId}.jsonl`)) {
          const candidate = join(dir, entry.name)
          const handle = await open(candidate, 'r').catch(() => null)
          if (handle !== null) {
            await handle.close()
            found = candidate
          }
        }
      }
    }
    await walk(sessionsRoot(), 0)
    scanResults.set(sessionId, found)
    return found
  }

  return {
    noteTranscript(sessionId, transcriptPath) {
      if (!isSessionsPath(transcriptPath)) return // forged or junk payload — drop
      rollouts.set(sessionId, transcriptPath)
    },

    async latestReply(sessionId) {
      if (!SESSION_ID_PATTERN.test(sessionId)) return null
      const file = await resolvePath(sessionId)
      if (file === null) return null
      let handle
      try {
        handle = await open(file, 'r')
      } catch {
        return null
      }
      try {
        const lines: string[] = []
        let totalBytes = 0
        let overflowed = false
        const reader = createInterface({ input: handle.createReadStream({ encoding: 'utf8' }), crlfDelay: Infinity })
        for await (const line of reader) {
          // Keep only candidate lines in memory (task_complete messages are
          // small; the giant response_item lines stream past and drop).
          totalBytes += line.length + 1
          if (totalBytes > byteCap) {
            overflowed = true
            break
          }
          if (line.includes('"task_complete"')) lines.push(line)
        }
        if (overflowed) return null
        const reply = extractLastCodexReply(lines)
        if (reply === null || reply.text === '') return null
        return { sessionId, turnId: reply.turnId, text: truncatePreview(reply.text), at: deps.now() }
      } finally {
        await handle.close()
      }
    },
  }
}
