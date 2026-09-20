/**
 * connectors/cc-dialogue-source.ts — the Claude Code reply-text source for
 * the dialogue bubble (Phase 15 unbinding). CC persists the session
 * transcript as JSONL at the path every hook payload carries in
 * `transcript_path` (~/.claude/projects/<cwd-slug>/<session-id>.jsonl).
 *
 * Transcript shape (spike-verified 2026-09-20 on live files, CC 2.1.234):
 * - mixed line types (mode/permission-mode/file-history-snapshot/attachment/
 *   system/last-prompt) — only `user` and `assistant` matter;
 * - every `user` line carries `promptId` (= the hook payload's prompt_id →
 *   the ledger's turnId), assistant lines never do — BUT the parentUuid
 *   chain from any main-chain assistant walks back to its user line (100%
 *   on live files), which recovers the turnId exactly;
 * - reply text = the `text` blocks of the LAST main-chain
 *   (`isSidechain !== true`) assistant message that has any — the model's
 *   final say, same semantics as zcode's "last stop-finishReason line";
 * - API-error assistant entries (isApiErrorMessage) are skipped.
 *
 * Session→file resolution: a registry fed by hook payloads (every event
 * refills it), with a one-shot projects-dir scan as fallback for a session
 * that started before the app booted (registry empty). Privacy: same
 * invariant as the zcode source — read on demand, truncated HERE, never
 * persisted, only through GET /api/petween-desktop/dialogue.
 */
import { createInterface } from 'node:readline'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { truncatePreview } from './dialogue-text'
import type { DialoguePreview, DialogueSource } from './dialogue-source'

const SESSION_ID_PATTERN = /^[\w.-]+$/
/** Per-line bound, same discipline as the zcode source (CC lines are small; damage guard). */
const MAX_LINE_BYTES = 4 * 1024 * 1024

interface TranscriptLine {
  type?: unknown
  uuid?: unknown
  parentUuid?: unknown
  isSidechain?: unknown
  promptId?: unknown
  isApiErrorMessage?: unknown
  message?: unknown
}

function textBlocksOf(line: TranscriptLine): string[] {
  const message = line.message
  if (typeof message !== 'object' || message === null) return []
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type !== 'text') continue
    if (typeof record.text !== 'string' || record.text.trim() === '') continue
    texts.push(record.text)
  }
  return texts
}

/**
 * Pure: reduce transcript lines to the last completed reply. Streaming
 * callers keep the whole file's uuid map in memory only as {uuid → parent,
 * promptId} pairs (a few hundred bytes per line worst case).
 */
export function extractLastCcReply(lines: string[]): { turnId: string | null; text: string } | null {
  const byUuid = new Map<string, { parentUuid: string | null; type?: unknown; promptId?: unknown }>()
  let last: { uuid: string; parentUuid: string | null; text: string } | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.length > MAX_LINE_BYTES) continue
    let entry: TranscriptLine
    try {
      entry = JSON.parse(trimmed) as TranscriptLine
    } catch {
      continue // the writer may be mid-append
    }
    if (entry.isSidechain === true) continue // subagent traffic never drives the pet
    if (typeof entry.uuid === 'string') {
      byUuid.set(entry.uuid, {
        parentUuid: typeof entry.parentUuid === 'string' ? entry.parentUuid : null,
        type: entry.type,
        promptId: typeof entry.promptId === 'string' ? entry.promptId : undefined,
      })
    }
    if (entry.type !== 'assistant' || entry.isApiErrorMessage === true) continue
    const texts = textBlocksOf(entry)
    if (texts.length === 0) continue
    if (typeof entry.uuid !== 'string') continue
    last = {
      uuid: entry.uuid,
      parentUuid: typeof entry.parentUuid === 'string' ? entry.parentUuid : null,
      text: texts.join('\n').trim(),
    }
  }
  if (last === null) return null
  // Walk the parent chain back to the user line carrying promptId.
  let turnId: string | null = null
  let cursor: { parentUuid: string | null; type?: unknown; promptId?: unknown } | undefined = byUuid.get(last.uuid)
  for (let hops = 0; cursor !== undefined && hops < 10_000; hops++) {
    if (cursor.type === 'user' && typeof cursor.promptId === 'string') {
      turnId = cursor.promptId
      break
    }
    cursor = cursor.parentUuid === null ? undefined : byUuid.get(cursor.parentUuid)
  }
  return { turnId, text: last.text }
}

export interface CcDialogueSource extends DialogueSource {
  /** Feed the session→transcript registry from a hook payload. Cheap; call on every event. */
  noteTranscript(sessionId: string, transcriptPath: string): void
}

export interface CcDialogueSourceDeps {
  /** ~/.claude — the scan fallback root when the registry has no path yet. */
  claudeDir(): string
  now(): number
}

export function createCcDialogueSource(deps: CcDialogueSourceDeps): CcDialogueSource {
  const transcripts = new Map<string, string>()
  const scanResults = new Map<string, string | null>()

  const resolvePath = async (sessionId: string): Promise<string | null> => {
    const known = transcripts.get(sessionId)
    if (known !== undefined) return known
    const scanned = scanResults.get(sessionId)
    if (scanned !== undefined) return scanned
    // One-shot projects scan: session ids are UUIDs, so a filename match is
    // authoritative; cached (positive and negative — the registry refills
    // from the next hook event anyway).
    let found: string | null = null
    try {
      const projects = join(deps.claudeDir(), 'projects')
      for (const dir of await readdir(projects, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue
        const candidate = join(projects, dir.name, `${sessionId}.jsonl`)
        const handle = await open(candidate, 'r').catch(() => null)
        if (handle !== null) {
          await handle.close()
          found = candidate
          break
        }
      }
    } catch {
      found = null
    }
    scanResults.set(sessionId, found)
    return found
  }

  return {
    noteTranscript(sessionId, transcriptPath) {
      transcripts.set(sessionId, transcriptPath)
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
        const reader = createInterface({ input: handle.createReadStream({ encoding: 'utf8' }), crlfDelay: Infinity })
        for await (const line of reader) {
          if (line.length > MAX_LINE_BYTES) continue
          lines.push(line)
        }
        const reply = extractLastCcReply(lines)
        if (reply === null || reply.text === '') return null
        return { sessionId, turnId: reply.turnId, text: truncatePreview(reply.text), at: deps.now() }
      } finally {
        await handle.close()
      }
    },
  }
}
