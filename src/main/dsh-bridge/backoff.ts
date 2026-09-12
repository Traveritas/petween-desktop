/**
 * dsh-bridge/backoff.ts — reconnect delays copied from the official DSH
 * ConnectionController (docs/03 §3.4): base 500ms, factor 2, cap 10s, and
 * the delay is drawn from the upper half of the cap window (jitter):
 * delay = cap/2 + random() * cap/2.
 */
const BASE_MS = 500
const FACTOR = 2
const MAX_MS = 10_000

export function backoffCapMs(attempt: number): number {
  const cap = BASE_MS * FACTOR ** Math.max(0, attempt)
  return Math.min(cap, MAX_MS)
}

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const cap = backoffCapMs(attempt)
  return cap / 2 + random() * (cap / 2)
}
