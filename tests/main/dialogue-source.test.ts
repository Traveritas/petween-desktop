/**
 * dialogue-source: rollout JSONL tail parsing + preview truncation. The
 * finishReason/toolCalls filters pick the model's FINAL reply, not mid-turn
 * reasoning; malformed (mid-append) lines are skipped.
 */
import { describe, expect, it } from 'vitest'
import { createDialogueSource, extractLastReply, truncatePreview } from '../../src/main/connectors/dialogue-source'

const modelIo = (over: Record<string, unknown>): string =>
  JSON.stringify({ type: 'model_io', turnId: 'turn_1', response: { finishReason: 'stop', text: '', ...over }, ...over })

describe('extractLastReply', () => {
  it('picks the last completed reply without tool calls', () => {
    const lines = [
      modelIo({ response: { finishReason: 'tool-calls', text: 'thinking aloud', toolCalls: [{ id: 't' }] } }),
      modelIo({ response: { finishReason: 'stop', text: 'intermediate summary', toolCalls: [{ id: 't2' }] } }),
      modelIo({ response: { finishReason: 'stop', text: 'All done: the fix landed.' } }),
      'not json at all {',
    ]
    expect(extractLastReply(lines)).toEqual({ turnId: 'turn_1', text: 'All done: the fix landed.' })
  })

  it('returns null without any completed reply', () => {
    expect(extractLastReply([modelIo({ response: { finishReason: 'length', text: 'partial' } })])).toBeNull()
    expect(extractLastReply([''])).toBeNull()
  })

  it('ignores non-model_io lines', () => {
    expect(extractLastReply([JSON.stringify({ type: 'other', response: { finishReason: 'stop', text: 'x' } })])).toBeNull()
  })
})

describe('truncatePreview', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    expect(truncatePreview('a\n\n  b')).toBe('a b')
    const long = 'x'.repeat(300)
    const cut = truncatePreview(long)
    expect(cut.length).toBeLessThanOrEqual(160)
    expect(cut.endsWith('…')).toBe(true)
  })
})

describe('createDialogueSource.latestReply (streaming)', () => {
  it('finds the last stop reply past many huge request lines (no tail window)', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'petween-dialogue-'))
    try {
      const filler = JSON.stringify({ type: 'model_io', turnId: 't', response: { finishReason: 'tool-calls', text: 'x'.repeat(300_000), toolCalls: [{ id: 't' }] } })
      const stop = JSON.stringify({ type: 'model_io', turnId: 'turn_final', response: { finishReason: 'stop', text: '最终答复：泡泡线完成。' } })
      // >8MB of filler dwarfing any fixed tail window before the stop line.
      const lines = Array.from({ length: 30 }, () => filler)
      await writeFile(join(dir, 'rollout', `model-io-s1.jsonl`), [...lines, stop, filler].join('\n'), { flag: 'w' }).catch(async () => {
        const { mkdir } = await import('node:fs/promises')
        await mkdir(join(dir, 'rollout'), { recursive: true })
        await writeFile(join(dir, 'rollout', `model-io-s1.jsonl`), [...lines, stop, filler].join('\n'))
      })
      const source = createDialogueSource({ cliDir: () => dir, now: () => 42 })
      const reply = await source.latestReply('s1')
      expect(reply).toEqual({ sessionId: 's1', turnId: 'turn_final', text: '最终答复：泡泡线完成。', at: 42 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns null for a session without a rollout file', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'petween-dialogue-'))
    try {
      const source = createDialogueSource({ cliDir: () => dir, now: () => 0 })
      expect(await source.latestReply('nope')).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
