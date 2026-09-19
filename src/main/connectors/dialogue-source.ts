/**
 * connectors/dialogue-source.ts — the reply-text source for the dialogue
 * bubble (Phase 10 second batch). zcode persists every model call as a JSONL
 * line in `<cli>/rollout/model-io-<sessionId>.jsonl` (AI-SDK shape:
 * {type:'model_io', turnId, response:{finishReason, text, toolCalls, usage}}),
 * verified live 2026-09-19 — the hook's temp transcript copy is deleted as
 * soon as the hook returns, so the rollout file is the durable source.
 *
 * Privacy boundary: this is the ONE content-level channel (deliberately so,
 * user-approved) — read on demand at turn end, reduced to a truncated preview
 * HERE, never persisted, served only through GET /api/petween-desktop/dialogue.
 */
import { createInterface } from 'node:readline'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

export interface DialoguePreview {
  sessionId: string
  turnId: string | null
  /** Truncated single-line preview of the last completed reply. */
  text: string
  at: number
}

export const DIALOGUE_MAX_CHARS = 160
/** Safety cap on candidate lines kept while streaming (one per turn in practice). */
const MAX_CANDIDATES = 64

/**
 * Pure: pick the last completed (finishReason 'stop', non-empty text, no tool
 * calls) reply from rollout lines, newest last. Lines that fail to parse are
 * skipped (the writer may be mid-append).
 */
export function extractLastReply(lines: string[]): { turnId: string | null; text: string } | null {
  let best: { turnId: string | null; text: string } | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { type?: unknown; turnId?: unknown; response?: unknown }
    if (record.type !== 'model_io') continue
    const response = record.response
    if (typeof response !== 'object' || response === null) continue
    const { finishReason, text, toolCalls } = response as { finishReason?: unknown; text?: unknown; toolCalls?: unknown }
    if (finishReason !== 'stop') continue
    if (typeof text !== 'string' || text.trim() === '') continue
    // A reply followed by tool calls is mid-turn reasoning, not the answer.
    if (Array.isArray(toolCalls) && toolCalls.length > 0) continue
    best = {
      turnId: typeof record.turnId === 'string' ? record.turnId : null,
      text: text.trim(),
    }
  }
  return best
}

/** Reply previews show PLAIN text — markdown markers would read as noise. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
}

export function truncatePreview(text: string): string {
  const single = stripMarkdown(text).replace(/\s+/g, ' ').trim()
  if (single.length <= DIALOGUE_MAX_CHARS) return single
  return `${single.slice(0, DIALOGUE_MAX_CHARS - 1).trimEnd()}…`
}

export interface DialogueSource {
  /** Null when the session has no rollout file (yet) or no completed reply. */
  latestReply(sessionId: string): Promise<DialoguePreview | null>
}

export interface DialogueSourceDeps {
  /** The zcode cli directory (rollout/ lives inside). Path injected for tests. */
  cliDir(): string
  now(): number
}

const SESSION_ID_PATTERN = /^[\w.-]+$/

export function createDialogueSource(deps: DialogueSourceDeps): DialogueSource {
  return {
    async latestReply(sessionId) {
      if (!SESSION_ID_PATTERN.test(sessionId)) return null
      const file = join(deps.cliDir(), 'rollout', `model-io-${sessionId}.jsonl`)
      let handle
      try {
        handle = await open(file, 'r')
      } catch {
        return null // no rollout for this session (yet) — not an error
      }
      try {
        // STREAM forward instead of a fixed tail window: one model_io line
        // embeds the whole request context (verified >1 MB per line on a long
        // session), so any window can miss the last stop line. The cheap
        // substring pre-filter means those giant non-stop lines never pay a
        // JSON.parse; memory stays at one line at a time.
        const candidates: string[] = []
        const reader = createInterface({ input: handle.createReadStream({ encoding: 'utf8' }), crlfDelay: Infinity })
        for await (const line of reader) {
          if (!line.includes('"stop"')) continue
          candidates.push(line)
          if (candidates.length > MAX_CANDIDATES) candidates.shift()
        }
        const reply = extractLastReply(candidates)
        if (reply === null) return null
        return { sessionId, turnId: reply.turnId, text: truncatePreview(reply.text), at: deps.now() }
      } finally {
        await handle.close()
      }
    },
  }
}
