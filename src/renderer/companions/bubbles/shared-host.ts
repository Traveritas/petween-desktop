/**
 * bubbles/shared-host.ts — one BubbleHost for every bubble companion. The
 * stats HUD and the dialogue bubbles both stack columns around the pet; two
 * independent hosts would overlap. Refcounted: the first acquire() creates
 * the host, the last release() disposes it (the overlay's settings-poll
 * remount cycle tears companions down together, so this is normally 1→0).
 */
import { createBubbleHost, type BubbleHost, type BubbleHostOptions } from './bubble-host'

let host: BubbleHost | null = null
let refcount = 0

export function acquireSharedBubbleHost(options: BubbleHostOptions): BubbleHost {
  refcount += 1
  if (host === null) host = createBubbleHost(options)
  return host
}

/** True when this call disposed the host (the caller released the last ref). */
export function releaseSharedBubbleHost(): boolean {
  refcount = Math.max(0, refcount - 1)
  if (refcount === 0 && host !== null) {
    host.dispose()
    host = null
    return true
  }
  return false
}
