/**
 * dsh-bridge/frames.ts — pure frame parsing/interpretation for the two DSH WS
 * downlink streams (docs/03 §2). Every frame arrives wrapped in a
 * server-request envelope; the mux stream only contributes session events
 * plus the subscribed baseline, the host stream contributes the disposed /
 * status / error signals the mux stream cannot carry. All other frame types
 * are ignored by contract (docs/03 §7 conversion 5).
 *
 * No ws / no timers — unit-tested directly against recorded shapes.
 */
import type { RawSessionEvent } from 'petween/integration/dsh/event-normalizer'

/** The unpacked server-request envelope. Anything else is not a downlink event. */
export interface ServerRequestEnvelope {
  method: string
  payload: unknown
}

export function parseServerFrame(raw: string): ServerRequestEnvelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const envelope = parsed as Record<string, unknown>
  if (envelope.type !== 'server-request') return null // server-response etc.
  if (typeof envelope.method !== 'string') return null
  return { method: envelope.method, payload: envelope.payload }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function sessionIdOf(frame: Record<string, unknown>): string | null {
  const id = frame.sessionId
  return typeof id === 'string' && id.length > 0 ? id : null
}

export type MuxAction =
  | { kind: 'session-event'; sessionId: string; event: RawSessionEvent }
  | { kind: 'subscribed'; sessionId: string }
  | { kind: 'stream-error' }
  | { kind: 'ignore' }

/**
 * Interprets a mux payload. The event object is passed through VERBATIM
 * (seq / sourceEventSeqs / surfaceOp / ignorable ride along); the host-only
 * `view` field is dropped (docs/03 §7 conversion 4).
 */
export function interpretMuxFrame(payload: unknown): MuxAction {
  const frame = asRecord(payload)
  if (frame === null) return { kind: 'ignore' }
  switch (frame.type) {
    case 'session/event': {
      const sessionId = sessionIdOf(frame)
      const event = asRecord(frame.event)
      if (sessionId === null || event === null) return { kind: 'ignore' }
      if (typeof event.type !== 'string' || typeof event.time !== 'number') return { kind: 'ignore' }
      // Pass the event through VERBATIM (seq/sourceEventSeqs/surfaceOp ride
      // along); the host-only `view` stays dropped at the frame level.
      return {
        kind: 'session-event',
        sessionId,
        event: event as unknown as RawSessionEvent,
      }
    }
    case 'session/subscribed': {
      const sessionId = sessionIdOf(frame)
      return sessionId === null ? { kind: 'ignore' } : { kind: 'subscribed', sessionId }
    }
    case 'stream/error':
      return { kind: 'stream-error' }
    default:
      // approval/*, question/*, session/queue, session/jobs, session/projection:
      // persisted approval events still arrive via session/event.
      return { kind: 'ignore' }
  }
}

export type HostAction =
  | { kind: 'session-removed'; sessionId: string }
  | { kind: 'session-status'; sessionId: string; running: boolean }
  | { kind: 'agent-error'; sessionId: string }
  | { kind: 'ignore' }

export function interpretHostFrame(payload: unknown): HostAction {
  const frame = asRecord(payload)
  if (frame === null) return { kind: 'ignore' }
  switch (frame.type) {
    case 'host/session-removed': {
      const sessionId = sessionIdOf(frame)
      return sessionId === null ? { kind: 'ignore' } : { kind: 'session-removed', sessionId }
    }
    case 'host/session-status': {
      const sessionId = sessionIdOf(frame)
      return sessionId === null || typeof frame.running !== 'boolean'
        ? { kind: 'ignore' }
        : { kind: 'session-status', sessionId, running: frame.running }
    }
    case 'host/agent-error': {
      const sessionId = sessionIdOf(frame)
      // message is dropped by contract (docs/03 §7 conversion 3).
      return sessionId === null ? { kind: 'ignore' } : { kind: 'agent-error', sessionId }
    }
    default:
      // host/session-added, host/workspace-*, host/remote-event, ...
      return { kind: 'ignore' }
  }
}
