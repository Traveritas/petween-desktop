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
 * Memory discipline (phase-review fix): STREAMING accumulation — only a
 * compact uuid→{parent,type,promptId} map and the current reply candidate
 * ever live in memory (never the raw lines), plus a total byte cap. Same
 * posture as the zcode source's one-line-at-a-time rule.
 *
 * Session→file resolution: a registry fed by hook payloads (every event
 * refills it) — paths are validated to live under ~/.claude/projects so a
 * forged hook POST cannot poison the registry into an arbitrary-file read
 * oracle — with a one-shot projects-dir scan as fallback for a session that
 * started before the app booted. Privacy: same invariant as the zcode
 * source — read on demand, truncated HERE, never persisted, only through
 * GET /api/petween-desktop/dialogue.
 */
import { createInterface } from 'node:readline'
import { open, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { truncatePreview } from './dialogue-text'
import type { DialoguePreview, DialogueSource } from './dialogue-source'

const SESSION_ID_PATTERN = /^[\w.-]+$/
/** Per-line bound, same discipline as the zcode source (CC lines are small; damage guard). */
const MAX_LINE_BYTES = 4 * 1024 * 1024
/** Total transcript byte cap — a long session must not OOM the main process. */
export const CC_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024
const MAX_PATH_CHARS = 4096

interface TranscriptLine {
  type?: unknown
  uuid?: unknown
  parentUuid?: unknown
  isSidechain?: unknown
  promptId?: unknown
  isApiErrorMessage?: unknown
  message?: unknown
}

interface ChainNode {
  parentUuid: string | null
  type?: unknown
  promptId?: unknown
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
 * Streaming reducer: fold transcript lines in, read the last completed
 * reply out. Memory = the uuid map (compact records) + one candidate.
 */
export function createCcReplyAccumulator(): {
  push(line: string): void
  result(): { turnId: string | null; text: string } | null
} {
  const byUuid = new Map<string, ChainNode>()
  let last: { uuid: string; text: string } | null = null

  const push = (raw: string): void => {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.length > MAX_LINE_BYTES) return
    let entry: TranscriptLine
    try {
      entry = JSON.parse(trimmed) as TranscriptLine
    } catch {
      return // the writer may be mid-append
    }
    if (entry.isSidechain === true) return // subagent traffic never drives the pet
    if (typeof entry.uuid === 'string') {
      byUuid.set(entry.uuid, {
        parentUuid: typeof entry.parentUuid === 'string' ? entry.parentUuid : null,
        type: entry.type,
        promptId: typeof entry.promptId === 'string' ? entry.promptId : undefined,
      })
    }
    if (entry.type !== 'assistant' || entry.isApiErrorMessage === true) return
    const texts = textBlocksOf(entry)
    if (texts.length === 0 || typeof entry.uuid !== 'string') return
    last = { uuid: entry.uuid, text: texts.join('\n').trim() }
  }

  const result = (): { turnId: string | null; text: string } | null => {
    if (last === null) return null
    // Walk the parent chain back to the user line carrying promptId.
    let turnId: string | null = null
    let cursor: ChainNode | undefined = byUuid.get(last.uuid)
    for (let hops = 0; cursor !== undefined && hops < 10_000; hops++) {
      if (cursor.type === 'user' && typeof cursor.promptId === 'string') {
        turnId = cursor.promptId
        break
      }
      cursor = cursor.parentUuid === null ? undefined : byUuid.get(cursor.parentUuid)
    }
    return { turnId, text: last.text }
  }

  return { push, result }
}

/** Pure convenience for tests / non-streaming callers. */
export function extractLastCcReply(lines: string[]): { turnId: string | null; text: string } | null {
  const accumulator = createCcReplyAccumulator()
  for (const line of lines) accumulator.push(line)
  return accumulator.result()
}

export interface CcDialogueSource extends DialogueSource {
  /** Feed the session→transcript registry from a hook payload. Cheap; call on every event. */
  noteTranscript(sessionId: string, transcriptPath: string): void
}

export interface CcDialogueSourceDeps {
  /** ~/.claude — the projects root under which transcript paths must live. */
  claudeDir(): string
  now(): number
  /** Test seam for the total byte cap. */
  maxTotalBytes?: number
}

export function createCcDialogueSource(deps: CcDialogueSourceDeps): CcDialogueSource {
  const transcripts = new Map<string, string>()
  const scanResults = new Map<string, string | null>()
  const byteCap = deps.maxTotalBytes ?? CC_TRANSCRIPT_MAX_BYTES

  /** Only paths INSIDE ~/.claude/projects enter the registry — a forged hook
   *  POST must not turn /dialogue into an arbitrary-file read oracle. */
  const projectsRoot = (): string => resolve(deps.claudeDir(), 'projects')
  const isProjectsPath = (candidate: string): boolean => {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > MAX_PATH_CHARS) return false
    let absolute: string
    try {
      absolute = resolve(candidate)
    } catch {
      return false
    }
    const root = projectsRoot()
    // Windows path comparison is case-insensitive; both sides are resolved.
    return absolute.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`)
  }

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
      const root = projectsRoot()
      for (const dir of await readdir(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue
        const candidate = join(root, dir.name, `${sessionId}.jsonl`)
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
      if (!isProjectsPath(transcriptPath)) return // forged or junk payload — drop
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
        const accumulator = createCcReplyAccumulator()
        let totalBytes = 0
        let overflowed = false
        const reader = createInterface({ input: handle.createReadStream({ encoding: 'utf8' }), crlfDelay: Infinity })
        for await (const line of reader) {
          totalBytes += line.length + 1
          if (totalBytes > byteCap) {
            overflowed = true
            break
          }
          accumulator.push(line)
        }
        if (overflowed) return null
        const reply = accumulator.result()
        if (reply === null || reply.text === '') return null
        return { sessionId, turnId: reply.turnId, text: truncatePreview(reply.text), at: deps.now() }
      } finally {
        await handle.close()
      }
    },
  }
}
