/**
 * codex dialogue source: task_complete extraction (turn_id +
 * last_agent_message served directly), the hook-fed registry with the
 * sessions-path validation, and the recursive suffix-scan fallback.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCodexDialogueSource, extractLastCodexReply } from '../../src/main/connectors/codex-dialogue-source'

const SESSION = '01a0a8d1-7933-7963-97b6-8e5e1e3047bc'

function metaLine(): string {
  return JSON.stringify({ timestamp: '2026-09-20T10:00:00Z', ordinal: 0, type: 'session_meta', payload: { id: SESSION } })
}

function responseLine(role: string, ordinal: number): string {
  return JSON.stringify({ timestamp: '2026-09-20T10:00:01Z', ordinal, type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text: 'x'.repeat(500_000) }] } })
}

function taskCompleteLine(turnId: string, message: string, ordinal: number, error?: unknown): string {
  return JSON.stringify({
    timestamp: '2026-09-20T10:00:02Z',
    ordinal,
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: turnId, last_agent_message: message, error: error ?? null, duration_ms: 5000 },
  })
}

describe('extractLastCodexReply', () => {
  it('picks the LAST task_complete with a non-empty message and its turn_id', () => {
    const reply = extractLastCodexReply([
      metaLine(),
      responseLine('user', 1),
      taskCompleteLine('turn_1', '第一轮回复。', 2),
      responseLine('user', 3),
      taskCompleteLine('turn_2', '第二轮回复，带 **加粗**。', 4),
    ])
    expect(reply).toEqual({ turnId: 'turn_2', text: '第二轮回复，带 **加粗**。' })
  })

  it('skips errored task_completes and empty messages; tolerates junk lines', () => {
    const reply = extractLastCodexReply([
      taskCompleteLine('turn_bad', '出错了', 1, 'rate_limited'),
      taskCompleteLine('turn_empty', '', 2),
      '{ broken',
      taskCompleteLine('turn_ok', '好的回复', 3),
    ])
    expect(reply).toEqual({ turnId: 'turn_ok', text: '好的回复' })
  })

  it('returns null with no usable task_complete', () => {
    expect(extractLastCodexReply([metaLine(), responseLine('assistant', 1)])).toBeNull()
  })
})

describe('createCodexDialogueSource', () => {
  async function withSessions<T>(run: (root: { codexDir: string; file: string }) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'petween-cxdlg-'))
    try {
      const codexDir = join(dir, 'codex')
      const day = join(codexDir, 'sessions', '2026', '09', '20')
      await mkdir(day, { recursive: true })
      const file = join(day, `rollout-2026-09-20T10-00-00-${SESSION}.jsonl`)
      await writeFile(
        file,
        [metaLine(), responseLine('user', 1), taskCompleteLine('turn_5', '这是给用户看的最终回复，含 `code`。', 2)].join('\n'),
        'utf8',
      )
      return await run({ codexDir, file })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('serves from the registry path, reduced to a plain truncated preview', async () => {
    await withSessions(async ({ codexDir, file }) => {
      const source = createCodexDialogueSource({ codexDir: () => codexDir, now: () => 42 })
      source.noteTranscript(SESSION, file)
      expect(await source.latestReply(SESSION)).toEqual({
        sessionId: SESSION,
        turnId: 'turn_5',
        text: '这是给用户看的最终回复，含 code。',
        at: 42,
      })
    })
  })

  it('falls back to the recursive suffix scan when the registry is empty', async () => {
    await withSessions(async ({ codexDir }) => {
      const source = createCodexDialogueSource({ codexDir: () => codexDir, now: () => 1 })
      const preview = await source.latestReply(SESSION)
      expect(preview?.turnId).toBe('turn_5')
    })
  })

  it('drops registry paths outside ~/.codex/sessions (forged-payload guard)', async () => {
    await withSessions(async ({ codexDir, file }) => {
      const source = createCodexDialogueSource({ codexDir: () => codexDir, now: () => 1 })
      source.noteTranscript(SESSION, 'C:/Windows/system32/config.json')
      source.noteTranscript(SESSION, file.replace(/sessions/, 'elsewhere'))
      // Rejected everywhere → scan still finds the real file.
      expect((await source.latestReply(SESSION))?.turnId).toBe('turn_5')
      source.noteTranscript(SESSION, file)
      expect((await source.latestReply(SESSION))?.text).toContain('最终回复')
    })
  })

  it('answers null for unknown/invalid sessions; caps total bytes', async () => {
    await withSessions(async ({ codexDir }) => {
      const source = createCodexDialogueSource({ codexDir: () => codexDir, now: () => 1 })
      expect(await source.latestReply('deadbeef-dead')).toBeNull()
      expect(await source.latestReply('../escape')).toBeNull()
      const capped = createCodexDialogueSource({ codexDir: () => codexDir, now: () => 1, maxTotalBytes: 16 })
      expect(await capped.latestReply(SESSION)).toBeNull() // the big response_line blows the cap
    })
  })

  it('rejects traversal, sibling-prefix, UNC; lowercase drive accepted', async () => {
    await withSessions(async ({ codexDir, file }) => {
      const source = createCodexDialogueSource({ codexDir: () => codexDir, now: () => 1 })
      const hostile = [
        // 5 levels up: file→day→month→year→sessions→codexDir (escapes the root).
        file.replace(/rollout/, 'x') + '/../../../../../Windows/win.ini',
        file.replace(/sessions/, 'sessions-evil'),
        String.raw`\server\share\sessions\x.jsonl`,
      ]
      for (const bad of hostile) source.noteTranscript(SESSION, bad)
      expect((await source.latestReply(SESSION))?.turnId).toBe('turn_5') // scan still finds the real file
      // Lowercase drive letter form of the real path is accepted (case-insensitive compare).
      const lowered = file.slice(0, 1).toLowerCase() + file.slice(1)
      source.noteTranscript(SESSION, lowered)
      expect((await source.latestReply(SESSION))?.turnId).toBe('turn_5')
    })
  })
})