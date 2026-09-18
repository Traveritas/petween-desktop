/**
 * bubbles/animations.ts — bubble entrance/exit animation presets (Phase 10).
 * A preset pairs an enter class and an exit class; keyframes are injected
 * once. Extensible like styles: registerBubbleAnimation at runtime.
 *
 * Exit classes must animate to a fully transparent/collapsed end state — the
 * host removes the element after EXIT_MS without waiting for transitionend
 * (a tab hidden mid-fade must still clean up; rAF is throttled there but the
 * timeout still fires).
 */

export interface BubbleAnimation {
  id: string
  label: string
  enterClass: string
  exitClass: string
  css?: string
}

/** Must cover the longest exit keyframe below. */
export const BUBBLE_EXIT_MS = 450

const registry = new Map<string, BubbleAnimation>()
const injected = new Set<string>()

export function registerBubbleAnimation(animation: BubbleAnimation): void {
  registry.set(animation.id, animation)
  if (animation.css !== undefined && !injected.has(animation.id) && typeof document !== 'undefined') {
    const style = document.createElement('style')
    style.setAttribute('data-pt-bubble-anim', animation.id)
    style.textContent = animation.css
    document.head.appendChild(style)
    injected.add(animation.id)
  }
}

export function listBubbleAnimations(): BubbleAnimation[] {
  return [...registry.values()]
}

export function getBubbleAnimation(id: string | undefined): BubbleAnimation {
  const animation = id === undefined ? undefined : registry.get(id)
  return animation ?? registry.values().next().value as BubbleAnimation
}

registerBubbleAnimation({
  id: 'pop',
  label: '弹出',
  enterClass: 'pt-bubble-enter-pop',
  exitClass: 'pt-bubble-exit-fade',
  css: `
@keyframes pt-bubble-pop-in {
  0% { transform: translate(-50%, 0) scale(0.5); opacity: 0; }
  70% { transform: translate(-50%, 0) scale(1.08); opacity: 1; }
  100% { transform: translate(-50%, 0) scale(1); opacity: 1; }
}
@keyframes pt-bubble-fade-out {
  to { opacity: 0; }
}
.pt-bubble-enter-pop { animation: pt-bubble-pop-in 260ms cubic-bezier(0.34, 1.56, 0.64, 1) both; }
.pt-bubble-exit-fade { animation: pt-bubble-fade-out 400ms ease both; }
`,
})

registerBubbleAnimation({
  id: 'rise',
  label: '升起',
  enterClass: 'pt-bubble-enter-rise',
  exitClass: 'pt-bubble-exit-sink',
  css: `
@keyframes pt-bubble-rise-in {
  from { transform: translate(-50%, 14px); opacity: 0; }
  to { transform: translate(-50%, 0); opacity: 1; }
}
@keyframes pt-bubble-sink-out {
  to { transform: translate(-50%, 10px); opacity: 0; }
}
.pt-bubble-enter-rise { animation: pt-bubble-rise-in 280ms ease-out both; }
.pt-bubble-exit-sink { animation: pt-bubble-sink-out 400ms ease-in both; }
`,
})

registerBubbleAnimation({
  id: 'fade',
  label: '淡入',
  enterClass: 'pt-bubble-enter-fade',
  exitClass: 'pt-bubble-exit-fade',
  css: `
@keyframes pt-bubble-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.pt-bubble-enter-fade { animation: pt-bubble-fade-in 240ms ease both; }
`,
})

registerBubbleAnimation({
  id: 'drop',
  label: '坠落',
  enterClass: 'pt-bubble-enter-drop',
  exitClass: 'pt-bubble-exit-fade',
  css: `
@keyframes pt-bubble-drop-in {
  0% { transform: translate(-50%, -18px); opacity: 0; }
  60% { transform: translate(-50%, 3px); opacity: 1; }
  100% { transform: translate(-50%, 0); opacity: 1; }
}
.pt-bubble-enter-drop { animation: pt-bubble-drop-in 340ms cubic-bezier(0.3, 0.9, 0.4, 1.2) both; }
`,
})
