/**
 * stdout-epipe-guard tests: the listener is attached to both streams, EPIPE
 * is swallowed, and any other error code still throws (the guard must never
 * become a silent catch-all).
 */
import { describe, expect, it } from 'vitest'
import { installStdoutEpipeGuard, type GuardableStream } from '../../src/main/stdout-epipe-guard'

function fakeStream() {
  const listeners: Array<(error: Error) => void> = []
  const stream: GuardableStream = {
    on: (_event, listener) => {
      listeners.push(listener)
    },
  }
  return { stream, listeners }
}

describe('installStdoutEpipeGuard', () => {
  it('attaches one error listener per stream and tolerates null/undefined', () => {
    const a = fakeStream()
    const b = fakeStream()
    expect(() => installStdoutEpipeGuard([a.stream, b.stream, null, undefined])).not.toThrow()
    expect(a.listeners).toHaveLength(1)
    expect(b.listeners).toHaveLength(1)
  })

  it('swallows EPIPE', () => {
    const a = fakeStream()
    installStdoutEpipeGuard([a.stream])
    expect(() => a.listeners[0](Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).not.toThrow()
  })

  it('rethrows every other error code', () => {
    const a = fakeStream()
    installStdoutEpipeGuard([a.stream])
    expect(() => a.listeners[0](Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toThrow('ECONNRESET')
    expect(() => a.listeners[0](new Error('plain'))).toThrow('plain')
  })

  it('defaults to the real process streams without throwing', () => {
    expect(() => installStdoutEpipeGuard()).not.toThrow()
  })
})
