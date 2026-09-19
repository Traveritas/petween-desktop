/**
 * bubbles/animations.ts — bubble enter/exit animation presets (Phase 10).
 * Enter and exit are INDEPENDENT registries: an attention-grabbing entrance
 * pairs naturally with a quiet exit, which a bundled preset cannot express.
 * The host removes the enter class before adding the exit one, so the two
 * never fight over the animation property — exit css order is irrelevant.
 *
 * Exit classes must animate to a fully transparent/collapsed end state — the
 * host removes the element after EXIT_MS without waiting for transitionend
 * (a tab hidden mid-fade must still clean up; rAF is throttled there but the
 * timeout still fires). Extensible like styles, at runtime.
 */

export interface BubbleEnterAnimation {
  id: string
  label: string
  className: string
  css?: string
}

export interface BubbleExitAnimation {
  id: string
  label: string
  className: string
  css?: string
  /** How long the host waits before removing the element (default BUBBLE_EXIT_MS). */
  durationMs?: number
}

/** Must cover the longest exit keyframe below. */
export const BUBBLE_EXIT_MS = 450

const enterRegistry = new Map<string, BubbleEnterAnimation>()
const exitRegistry = new Map<string, BubbleExitAnimation>()
const injected = new Set<string>()

function injectCss(id: string, css: string | undefined): void {
  if (css === undefined || injected.has(id) || typeof document === 'undefined') return
  const style = document.createElement('style')
  style.setAttribute('data-pt-bubble-anim', id)
  style.textContent = css
  document.head.appendChild(style)
  injected.add(id)
}

export function registerBubbleEnterAnimation(animation: BubbleEnterAnimation): void {
  enterRegistry.set(animation.id, animation)
  injectCss(animation.id, animation.css)
}

export function registerBubbleExitAnimation(animation: BubbleExitAnimation): void {
  exitRegistry.set(animation.id, animation)
  injectCss(animation.id, animation.css)
}

export function listBubbleEnterAnimations(): BubbleEnterAnimation[] {
  return [...enterRegistry.values()]
}

export function listBubbleExitAnimations(): BubbleExitAnimation[] {
  return [...exitRegistry.values()]
}

export function getBubbleEnterAnimation(id: string | undefined): BubbleEnterAnimation {
  const animation = id === undefined ? undefined : enterRegistry.get(id)
  return animation ?? (enterRegistry.values().next().value as BubbleEnterAnimation)
}

export function getBubbleExitAnimation(id: string | undefined): BubbleExitAnimation {
  const animation = id === undefined ? undefined : exitRegistry.get(id)
  return animation ?? (exitRegistry.values().next().value as BubbleExitAnimation)
}

/**
 * The pre-split bundled presets (v0.2.2/0.2.3 stored `animationId`): the exit
 * each one used, so an existing pick migrates to the same look.
 */
export const LEGACY_BUNDLED_EXITS: Readonly<Record<string, string>> = {
  pop: 'fade',
  rise: 'sink',
  fade: 'fade',
  drop: 'fade',
}

// --- Enter presets ------------------------------------------------------------

registerBubbleEnterAnimation({
  id: 'pop',
  label: '弹出',
  className: 'pt-bubble-enter-pop',
  css: `
@keyframes pt-bubble-pop-in {
  0% { transform: translate(-50%, 0) scale(0.5); opacity: 0; }
  70% { transform: translate(-50%, 0) scale(1.08); opacity: 1; }
  100% { transform: translate(-50%, 0) scale(1); opacity: 1; }
}
.pt-bubble-enter-pop { animation: pt-bubble-pop-in 260ms cubic-bezier(0.34, 1.56, 0.64, 1) both; }
`,
})

registerBubbleEnterAnimation({
  id: 'rise',
  label: '升起',
  className: 'pt-bubble-enter-rise',
  css: `
@keyframes pt-bubble-rise-in {
  from { transform: translate(-50%, 14px); opacity: 0; }
  to { transform: translate(-50%, 0); opacity: 1; }
}
.pt-bubble-enter-rise { animation: pt-bubble-rise-in 280ms ease-out both; }
`,
})

registerBubbleEnterAnimation({
  id: 'fade',
  label: '淡入',
  className: 'pt-bubble-enter-fade',
  css: `
@keyframes pt-bubble-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.pt-bubble-enter-fade { animation: pt-bubble-fade-in 240ms ease both; }
`,
})

registerBubbleEnterAnimation({
  id: 'drop',
  label: '坠落',
  className: 'pt-bubble-enter-drop',
  css: `
@keyframes pt-bubble-drop-in {
  0% { transform: translate(-50%, -18px); opacity: 0; }
  60% { transform: translate(-50%, 3px); opacity: 1; }
  100% { transform: translate(-50%, 0); opacity: 1; }
}
.pt-bubble-enter-drop { animation: pt-bubble-drop-in 340ms cubic-bezier(0.3, 0.9, 0.4, 1.2) both; }
`,
})

registerBubbleEnterAnimation({
  id: 'drift-in',
  label: '飘落',
  className: 'pt-bubble-enter-drift-in',
  // Two independent animations so each easing stays clean: the FALL (with
  // the fade) runs one smooth curve, the SWAY oscillates on its own
  // properties (translate for horizontal drift + rotate for a light tilt)
  // with per-half-period ease-in-out. Wind is stronger higher up: the sway
  // envelope DECAYS as the bubble falls and settles (user spec v0.3.9).
  css: `
.pt-bubble-enter-drift-in {
  animation:
    pt-bubble-drift-fall 640ms cubic-bezier(0.3, 0.7, 0.4, 1) both,
    pt-bubble-drift-in-sway 640ms ease-in-out both;
}
@keyframes pt-bubble-drift-fall {
  from { transform: translate(-50%, -34px); opacity: 0; }
  60% { opacity: 0.9; }
  to { transform: translate(-50%, 0); opacity: 1; }
}
@keyframes pt-bubble-drift-in-sway {
  0% { rotate: -3.2deg; translate: -14px 0; }
  30% { rotate: 2.4deg; translate: 10px 0; }
  60% { rotate: -1.4deg; translate: -6px 0; }
  85% { rotate: 0.6deg; translate: 2px 0; }
  100% { rotate: 0deg; translate: 0px 0; }
}
`,
})

// --- Exit presets -------------------------------------------------------------

registerBubbleExitAnimation({
  id: 'fade',
  label: '淡出',
  className: 'pt-bubble-exit-fade',
  css: `
@keyframes pt-bubble-fade-out {
  to { opacity: 0; }
}
.pt-bubble-exit-fade { animation: pt-bubble-fade-out 400ms ease both; }
`,
})

registerBubbleExitAnimation({
  id: 'sink',
  label: '沉落',
  className: 'pt-bubble-exit-sink',
  css: `
@keyframes pt-bubble-sink-out {
  to { transform: translate(-50%, 10px); opacity: 0; }
}
.pt-bubble-exit-sink { animation: pt-bubble-sink-out 400ms ease-in both; }
`,
})

registerBubbleExitAnimation({
  id: 'shrink',
  label: '缩小',
  className: 'pt-bubble-exit-shrink',
  css: `
@keyframes pt-bubble-shrink-out {
  to { transform: translate(-50%, 0) scale(0.6); opacity: 0; }
}
.pt-bubble-exit-shrink { animation: pt-bubble-shrink-out 380ms ease-in both; }
`,
})

registerBubbleExitAnimation({
  id: 'drift',
  label: '随风',
  className: 'pt-bubble-exit-drift',
  // Same two-property split as 飘落, with the envelope REVERSED: the bubble
  // rises into stronger wind, so the sway GROWS until it fades out.
  css: `
.pt-bubble-exit-drift {
  animation:
    pt-bubble-drift-rise 1000ms cubic-bezier(0.3, 0.4, 0.5, 1) both,
    pt-bubble-drift-out-sway 1000ms ease-in-out both;
}
@keyframes pt-bubble-drift-rise {
  0% { transform: translate(-50%, 0); opacity: 1; }
  40% { opacity: 0.88; }
  100% { transform: translate(-50%, -46px); opacity: 0; }
}
@keyframes pt-bubble-drift-out-sway {
  0% { rotate: 0deg; translate: 0px 0; }
  22% { rotate: 1.2deg; translate: 6px 0; }
  50% { rotate: -1.8deg; translate: -9px 0; }
  78% { rotate: 2.6deg; translate: 13px 0; }
  100% { rotate: -3.4deg; translate: -17px 0; }
}
`,
  durationMs: 1050,
})
