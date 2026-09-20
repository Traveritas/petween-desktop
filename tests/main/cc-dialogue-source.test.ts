/**
 * cc dialogue source: transcript reduction (parent-chain turnId recovery,
 * sidechain/API-error exclusion, last-assistant-with-text), the hook-fed
 * registry, and the projects-dir scan fallback. Spike facts pinned:
 * docs/07 §6.5 / cc-dialogue-source.ts header.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCcDialogueSource, extractLastCcReply } from '../../src/main/connectors/cc-dialogue-source'

const SESSION = '7fb28543-52c9-4880-a328-dd2dff79d447'

function userLine(promptId: string, uuid: string, text = 'hi'): string {
  return JSON.stringify({ type: 'user', uuid, parentUuid: null, isSidechain: false, promptId, message: { role: 'user', content: text } })
}

function assistantLine(uuid: string, parentUuid: string, blocks: Array<{ type: string; text?: string }>): string {
  return JSON.stringify({ type: 'assistant', uuid, parentUuid, isSidechain: false, message: { role: 'assistant', content: blocks } })
}

describe('extractLastCcReply', () => {
  it('recovers the promptId via the parentUuid chain from the last text-bearing assistant', () => {
    const reply = extractLastCcReply([
      JSON.stringify({ type: 'mode', mode: 'normal', sessionId: SESSION }), // noise line
      userLine('prompt_1', 'u1'),
      assistantLine('a1', 'u1', [{ type: 'thinking', thinking: '…' }]), // no text block
      assistantLine('a2', 'a1', [{ type: 'tool_use', name: 'Bash' }]), // no text block
      assistantLine('a3', 'a2', [{ type: 'text', text: '修好了。' }]),
    ])
    expect(reply).toEqual({ turnId: 'prompt_1', text: '修好了。' })
  })

  it('picks the LAST assistant with text (mid-turn commentary is not the reply)', () => {
    const reply = extractLastCcReply([
      userLine('prompt_1', 'u1'),
      assistantLine('a1', 'u1', [{ type: 'text', text: '我先看看文件。' }]),
      assistantLine('a2', 'a1', [{ type: 'tool_use', name: 'Edit' }]),
      assistantLine('a3', 'a2', [{ type: 'text', text: '完成：已修复 A。' }]),
    ])
    expect(reply?.text).toBe('完成：已修复 A。')
  })

  it('joins multiple text blocks and follows the chain across hops', () => {
    const reply = extractLastCcReply([
      userLine('prompt_9', 'u9'),
      assistantLine('a1', 'u9', [{ type: 'tool_use' }]),
      assistantLine('a2', 'a1', [{ type: 'text', text: '第一段。' }, { type: 'text', text: '第二段。' }]),
    ])
    expect(reply).toEqual({ turnId: 'prompt_9', text: '第一段。\n第二段。' })
  })

  it('excludes sidechain (subagent) assistants and API-error entries', () => {
    const reply = extractLastCcReply([
      userLine('prompt_1', 'u1'),
      JSON.stringify({ type: 'assistant', uuid: 's1', parentUuid: 'u1', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: '子代理私货' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'e1', parentUuid: 'u1', isSidechain: false, isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'API error' }] } }),
      assistantLine('a1', 'u1', [{ type: 'text', text: '正主回复' }]),
    ])
    expect(reply?.text).toBe('正主回复')
  })

  it('returns null without any text-bearing assistant; skips malformed/oversized lines', () => {
    expect(extractLastCcReply([userLine('p', 'u1'), assistantLine('a1', 'u1', [{ type: 'tool_use' }])])).toBeNull()
    expect(extractLastCcReply(['{ broken', '', 'x'.repeat(5 * 1024 * 1024)])).toBeNull()
  })

  it('turnId is null when the chain never reaches a promptId user line', () => {
    const reply = extractLastCcReply([assistantLine('a1', 'orphan', [{ type: 'text', text: '无主回复' }])])
    expect(reply).toEqual({ turnId: null, text: '无主回复' })
  })
})

describe('createCcDialogueSource', () => {
  const transcriptOf = (dir: string): string => join(dir, `${SESSION}.jsonl`)

  async function withProjects<T>(run: (projectsRoot: { claudeDir: string; file: string }) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'petween-ccdlg-'))
    try {
      const claudeDir = join(dir, 'claude')
      const projectDir = join(claudeDir, 'projects', 'D--proj')
      await mkdir(projectDir, { recursive: true })
      const file = transcriptOf(projectDir)
      await writeFile(
        file,
        [
          userLine('prompt_5', 'u1'),
          assistantLine('a1', 'u1', [{ type: 'text', text: '这是给用户看的最终回复，包含 **加粗** 和 `code`。' }]),
        ].join('\n'),
        'utf8',
      )
      return await run({ claudeDir, file })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('serves from the registry path, with markdown stripped and truncated', async () => {
    await withProjects(async ({ claudeDir, file }) => {
      const source = createCcDialogueSource({ claudeDir: () => claudeDir, now: () => 42 })
      source.noteTranscript(SESSION, file)
      const preview = await source.latestReply(SESSION)
      expect(preview).toEqual({
        sessionId: SESSION,
        turnId: 'prompt_5',
        text: '这是给用户看的最终回复，包含 加粗 和 code。',
        at: 42,
      })
    })
  })

  it('falls back to a projects-dir scan when the registry is empty (app restarted mid-session)', async () => {
    await withProjects(async ({ claudeDir }) => {
      const source = createCcDialogueSource({ claudeDir: () => claudeDir, now: () => 1 })
      const preview = await source.latestReply(SESSION)
      expect(preview?.turnId).toBe('prompt_5')
    })
  })

  it('answers null for unknown sessions and rejects invalid ids without touching disk', async () => {
    await withProjects(async ({ claudeDir }) => {
      const source = createCcDialogueSource({ claudeDir: () => claudeDir, now: () => 1 })
      expect(await source.latestReply('cc_deadbeef')).toBeNull()
      expect(await source.latestReply('../escape')).toBeNull()
    })
  })

  it('drops registry paths outside ~/.claude/projects (forged-payload guard, phase-review fix)', async () => {
    await withProjects(async ({ claudeDir, file }) => {
      const source = createCcDialogueSource({ claudeDir: () => claudeDir, now: () => 1 })
      source.noteTranscript(SESSION, 'C:/Windows/system32/config.json') // outside projects
      source.noteTranscript(SESSION, file.replace('/projects/', '/elsewhere/')) // sibling of projects
      source.noteTranscript(SESSION, '') // junk
      // Registry rejected everything → falls to scan → finds the real file.
      const preview = await source.latestReply(SESSION)
      expect(preview?.turnId).toBe('prompt_5')
      // A valid path still registers and wins over the scan.
      source.noteTranscript(SESSION, file)
      expect((await source.latestReply(SESSION))?.text).toContain('最终回复')
    })
  })

  it('caps total transcript bytes — an oversized file answers null, not OOM', async () => {
    await withProjects(async ({ claudeDir }) => {
      const source = createCcDialogueSource({ claudeDir: () => claudeDir, now: () => 1, maxTotalBytes: 16 })
      // The fixture file is well over 16 bytes total.
      expect(await source.latestReply(SESSION)).toBeNull()
    })
  })
})
