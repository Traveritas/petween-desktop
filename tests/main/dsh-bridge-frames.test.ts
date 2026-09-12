/**
 * Frame interpretation tests against the recorded DSH shapes (docs/03 §2):
 * envelope unpacking, the mux/host action mapping, and every ignore case.
 */
import { describe, expect, it } from 'vitest'
import {
  interpretHostFrame,
  interpretMuxFrame,
  parseServerFrame,
} from '../../src/main/dsh-bridge/frames'

function envelope(method: string, payload: unknown): string {
  return JSON.stringify({ type: 'server-request', rpcId: 'rpc-1', method, payload })
}

describe('parseServerFrame', () => {
  it('unpacks server-request envelopes', () => {
    expect(parseServerFrame(envelope('session/event', { type: 'session/event' }))).toEqual({
      method: 'session/event',
      payload: { type: 'session/event' },
    })
  })

  it('rejects non-server-request frames and broken JSON', () => {
    expect(
      parseServerFrame(JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: true } })),
    ).toBeNull()
    expect(parseServerFrame('not json')).toBeNull()
    expect(parseServerFrame('42')).toBeNull()
  })
})

describe('interpretMuxFrame (docs/03 §2.2)', () => {
  it('extracts session events verbatim (seq/sourceEventSeqs ride along)', () => {
    const event = {
      type: 'assistant/chunk',
      time: 1_789_000_000_000,
      seq: 42,
      data: { chunk: { type: 'reasoning-delta' } },
    }
    const action = interpretMuxFrame({ type: 'session/event', sessionId: 'session-3', event, view: { x: 1 } })
    expect(action).toEqual({ kind: 'session-event', sessionId: 'session-3', event })
  })

  it('collects subscribed baseline frames', () => {
    expect(interpretMuxFrame({ type: 'session/subscribed', sessionId: 'session-1', lastSeq: 9 })).toEqual({
      kind: 'subscribed',
      sessionId: 'session-1',
    })
  })

  it('treats stream/error as a stream termination', () => {
    expect(interpretMuxFrame({ type: 'stream/error', error: { message: 'x' } })).toEqual({ kind: 'stream-error' })
  })

  it('ignores the open-flood control frames', () => {
    for (const type of [
      'approval/asked',
      'approval/decided',
      'question/asked',
      'session/queue',
      'session/jobs',
      'session/projection',
      'host/session-added',
    ]) {
      expect(interpretMuxFrame({ type })).toEqual({ kind: 'ignore' })
    }
  })

  it('ignores malformed session events', () => {
    expect(interpretMuxFrame({ type: 'session/event', event: { type: 'turn/start' } })).toEqual({ kind: 'ignore' })
    expect(interpretMuxFrame({ type: 'session/event', sessionId: 's', event: 'nope' })).toEqual({ kind: 'ignore' })
    expect(interpretMuxFrame(null)).toEqual({ kind: 'ignore' })
  })
})

describe('interpretHostFrame (docs/03 §2.3)', () => {
  it('maps host/session-removed → session-removed', () => {
    expect(interpretHostFrame({ type: 'host/session-removed', sessionId: 'session-2' })).toEqual({
      kind: 'session-removed',
      sessionId: 'session-2',
    })
  })

  it('maps host/session-status keeping the boolean (conversion happens at the relay emit)', () => {
    expect(interpretHostFrame({ type: 'host/session-status', sessionId: 's', running: false })).toEqual({
      kind: 'session-status',
      sessionId: 's',
      running: false,
    })
    expect(interpretHostFrame({ type: 'host/session-status', sessionId: 's', running: true })).toEqual({
      kind: 'session-status',
      sessionId: 's',
      running: true,
    })
  })

  it('maps host/agent-error dropping the message', () => {
    expect(interpretHostFrame({ type: 'host/agent-error', sessionId: 's', message: 'boom' })).toEqual({
      kind: 'agent-error',
      sessionId: 's',
    })
  })

  it('ignores other host frames', () => {
    for (const type of ['host/session-added', 'host/workspace-changed', 'host/remote-event']) {
      expect(interpretHostFrame({ type })).toEqual({ kind: 'ignore' })
    }
  })
})
