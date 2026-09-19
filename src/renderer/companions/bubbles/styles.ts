/**
 * bubbles/styles.ts — the bubble style registry (Phase 10). A style owns the
 * visual skin of a bubble; the host owns lifecycle/positioning. Styles are
 * developer-extensible: `registerBubbleStyle` adds an entry at runtime (the
 * settings card lists whatever is registered when it opens).
 *
 * Render contract (host relies on these hooks for live updates):
 * - thinking content must render one element matching `.pt-bubble__timer`
 * - edit content must render `.pt-bubble__lines` (the +/- values) and may
 *   render `.pt-bubble__files`
 * Everything else inside the element is the style's own business. Built-ins
 * use textContent only — no markup injection from data.
 */

export type BubbleContent =
  | { kind: 'thinking'; sessionId: string; startedAt: number }
  /** added/removed are the EPISODE totals (live while working); null = unknown counts. */
  | { kind: 'edit'; sessionId: string; added: number | null; removed: number | null; files: number }
  /** Turn-end summary (完成提醒): per-turn deltas + wall duration. */
  | {
      kind: 'turn'
      sessionId: string
      thinkingMs: number
      linesAdded: number
      linesRemoved: number
      edits: number
      durationMs: number
    }
  /** The model's last reply preview (dialogue bubble; already truncated main-side). */
  | { kind: 'reply'; sessionId: string; text: string }

export interface BubbleStyle {
  id: string
  label: string
  /** Extra class on the bubble element; selectors in `css` root here. */
  className: string
  /** Injected once into the document (idempotent). */
  css?: string
  render(el: HTMLElement, content: BubbleContent): void
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000
  if (totalSeconds < 60) return `${Math.floor(totalSeconds)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, '0')}`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60}m`
}

export function formatLines(added: number | null, removed: number | null): string {
  if (added === null && removed === null) return '±? 行'
  const parts: string[] = []
  if (added !== null && added !== 0) parts.push(`+${added}`)
  if (removed !== null && removed !== 0) parts.push(`−${removed}`)
  if (parts.length === 0) return '无变化'
  return `${parts.join(' ')} 行`
}

const registry = new Map<string, BubbleStyle>()
const injected = new Set<string>()

function injectCss(id: string, css: string | undefined): void {
  if (css === undefined || injected.has(id) || typeof document === 'undefined') return
  const style = document.createElement('style')
  style.setAttribute('data-pt-bubble-style', id)
  style.textContent = css
  document.head.appendChild(style)
  injected.add(id)
}

export function registerBubbleStyle(style: BubbleStyle): void {
  registry.set(style.id, style)
  injectCss(style.id, style.css)
}

export function listBubbleStyles(): BubbleStyle[] {
  return [...registry.values()]
}

export function getBubbleStyle(id: string | undefined): BubbleStyle {
  const style = id === undefined ? undefined : registry.get(id)
  return style ?? registry.values().next().value as BubbleStyle
}

const thinkingLabel = (el: HTMLElement): HTMLElement => {
  let label = el.querySelector<HTMLElement>('.pt-bubble__label')
  if (label === null) {
    label = document.createElement('span')
    label.className = 'pt-bubble__label'
    el.appendChild(label)
  }
  return label
}

const valueOf = (el: HTMLElement, className: string): HTMLElement => {
  let node = el.querySelector<HTMLElement>(className)
  if (node === null) {
    node = document.createElement('span')
    node.className = className.replace(/^\./, '')
    el.appendChild(node)
  }
  return node
}

/** Shared renderers used by the built-ins (and handy for custom styles). */
export function renderThinking(el: HTMLElement, content: Extract<BubbleContent, { kind: 'thinking' }>): void {
  thinkingLabel(el).textContent = '思考'
  valueOf(el, '.pt-bubble__timer').textContent = formatDuration(Math.max(0, Date.now() - content.startedAt))
}

export function renderEdit(el: HTMLElement, content: Extract<BubbleContent, { kind: 'edit' }>): void {
  thinkingLabel(el).textContent = '写入'
  valueOf(el, '.pt-bubble__lines').textContent = formatLines(content.added, content.removed)
  const files = valueOf(el, '.pt-bubble__files')
  files.textContent = content.files > 1 ? `${content.files} 个文件` : ''
}

export function renderTurn(el: HTMLElement, content: Extract<BubbleContent, { kind: 'turn' }>): void {
  thinkingLabel(el).textContent = '完成'
  const parts: string[] = []
  if (content.thinkingMs > 0) parts.push(`思考 ${formatDuration(content.thinkingMs)}`)
  if (content.linesAdded !== 0 || content.linesRemoved !== 0) {
    parts.push(formatLines(content.linesAdded, content.linesRemoved))
  } else if (content.edits > 0) {
    parts.push(`${content.edits} 次编辑`)
  }
  if (parts.length === 0) parts.push('回合结束')
  parts.push(formatDuration(content.durationMs))
  valueOf(el, '.pt-bubble__turn').textContent = parts.join(' · ')
}

export function renderReply(el: HTMLElement, content: Extract<BubbleContent, { kind: 'reply' }>): void {
  el.classList.add('pt-bubble--wrap')
  thinkingLabel(el).textContent = '回复'
  valueOf(el, '.pt-bubble__reply').textContent = content.text
}

/** The built-in skins are pure looks: every one renders with the shared
 * kind renderers, so new styles stay CSS-only entries. */
export function renderStandard(el: HTMLElement, content: BubbleContent): void {
  if (content.kind === 'thinking') renderThinking(el, content)
  else if (content.kind === 'turn') renderTurn(el, content)
  else if (content.kind === 'reply') renderReply(el, content)
  else renderEdit(el, content)
}

// --- Built-in styles ---------------------------------------------------------

registerBubbleStyle({
  id: 'glass',
  label: '玻璃',
  className: 'pt-bubble--glass',
  css: `
.pt-bubble--glass {
  background: rgba(24, 28, 38, 0.62);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  color: #f4f6fb;
  font-size: 13px;
  line-height: 1;
  padding: 6px 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
}
.pt-bubble--glass .pt-bubble__label { opacity: 0.65; margin-right: 6px; }
.pt-bubble--glass .pt-bubble__timer { font-variant-numeric: tabular-nums; font-weight: 600; }
.pt-bubble--glass .pt-bubble__lines { font-variant-numeric: tabular-nums; font-weight: 600; }
.pt-bubble--glass .pt-bubble__files { opacity: 0.65; margin-left: 6px; font-weight: 400; }
/* Kind refinements: a pill suits short chips; paragraphs and summaries get
   card shapes (user feedback v0.3.7). */
.pt-bubble--glass.pt-bubble--kind-reply {
  border-radius: 14px;
  padding: 10px 14px;
  line-height: 1.55;
  text-align: left;
}
.pt-bubble--glass.pt-bubble--kind-reply .pt-bubble__label {
  display: block;
  margin: 0 0 4px;
  font-size: 11px;
  letter-spacing: 0.04em;
}
.pt-bubble--glass.pt-bubble--kind-turn {
  border-radius: 16px;
  padding: 8px 16px;
}

`,
  render: renderStandard,
})

registerBubbleStyle({
  id: 'terminal',
  label: '终端',
  className: 'pt-bubble--terminal',
  css: `
.pt-bubble--terminal {
  background: #101418;
  border: 1px solid #2f3b47;
  border-radius: 4px;
  color: #9fe8b5;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1;
  padding: 5px 9px;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35);
}
.pt-bubble--terminal .pt-bubble__label { color: #5d7285; margin-right: 6px; }
.pt-bubble--terminal .pt-bubble__timer,
.pt-bubble--terminal .pt-bubble__lines { color: #ffd479; font-weight: 600; }
.pt-bubble--terminal .pt-bubble__files { color: #5d7285; margin-left: 6px; }
.pt-bubble--terminal.pt-bubble--kind-reply {
  padding: 9px 12px;
  line-height: 1.55;
  text-align: left;
  border-radius: 6px;
}
.pt-bubble--terminal.pt-bubble--kind-reply .pt-bubble__label {
  display: block;
  margin: 0 0 4px;
  font-size: 11px;
}
.pt-bubble--terminal.pt-bubble--kind-turn {
  padding: 7px 12px;
  border-radius: 6px;
}

`,
  render: renderStandard,
})

registerBubbleStyle({
  id: 'soft',
  label: '浅色',
  className: 'pt-bubble--soft',
  css: `
.pt-bubble--soft {
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 10px;
  color: #2a3346;
  font-size: 13px;
  line-height: 1;
  padding: 6px 11px;
  box-shadow: 0 3px 12px rgba(20, 30, 60, 0.18);
}
.pt-bubble--soft .pt-bubble__label { color: #8a93a8; margin-right: 6px; }
.pt-bubble--soft .pt-bubble__timer,
.pt-bubble--soft .pt-bubble__lines { color: #3b7dd8; font-weight: 700; }
.pt-bubble--soft .pt-bubble__files { color: #8a93a8; margin-left: 6px; }
.pt-bubble--soft.pt-bubble--kind-reply {
  border-radius: 12px;
  padding: 10px 14px;
  line-height: 1.55;
  text-align: left;
}
.pt-bubble--soft.pt-bubble--kind-reply .pt-bubble__label {
  display: block;
  margin: 0 0 4px;
  font-size: 11px;
}
.pt-bubble--soft.pt-bubble--kind-turn {
  border-radius: 12px;
  padding: 8px 14px;
}

`,
  render: renderStandard,
})

// --- v0.3.15 styles: comic / memo / neon / ink -------------------------------

registerBubbleStyle({
  id: 'comic',
  label: '漫画',
  className: 'pt-bubble--comic',
  css: `
/* The classic speech bubble: paper + ink outline + a tail pointing at the
   pet. The tail is a 45°-rotated square whose border-right/bottom form the
   pointer V (the top vertex stays open so it merges into the bubble; the
   opaque paper of the pseudo covers the parent's border seam behind it).
   It repositions per placement: columns hang above the pet (tail bottom),
   reply previews sit at the pet's left (tail right), turn summaries below
   (tail top). */
.pt-bubble--comic {
  background: #fffdf6;
  border: 2px solid #232a3d;
  border-radius: 13px;
  color: #232a3d;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  padding: 6px 13px;
  box-shadow: 2px 3px 0 rgba(35, 42, 61, 0.16);
}
.pt-bubble--comic::after {
  content: '';
  position: absolute;
  bottom: -7.5px;
  left: 50%;
  width: 12px;
  height: 12px;
  background: #fffdf6;
  border-right: 2px solid #232a3d;
  border-bottom: 2px solid #232a3d;
  transform: translateX(-50%) rotate(45deg);
}
/* At the pet's left the tail points right: the rotated square's RIGHT
   vertex is the pointer, so its two edges (top+right) carry the ink. */
.pt-bubble--at-left.pt-bubble--comic::after {
  bottom: auto;
  left: auto;
  right: -7.5px;
  top: 50%;
  border-right-width: 0;
  border-bottom-width: 0;
  border-top: 2px solid #232a3d;
  border-right: 2px solid #232a3d;
  transform: translateY(-50%) rotate(45deg);
}
/* Below the pet the tail points up: the TOP vertex is the pointer, edges
   left+top. */
.pt-bubble--at-below.pt-bubble--comic::after {
  bottom: auto;
  left: 50%;
  top: -7.5px;
  border-bottom-width: 0;
  border-top: 2px solid #232a3d;
  border-left: 2px solid #232a3d;
  transform: translateX(-50%) rotate(45deg);
}
.pt-bubble--comic .pt-bubble__label { color: #6b7694; margin-right: 6px; font-weight: 600; }
.pt-bubble--comic .pt-bubble__timer { font-variant-numeric: tabular-nums; font-weight: 700; }
.pt-bubble--comic .pt-bubble__lines { font-variant-numeric: tabular-nums; font-weight: 700; }
.pt-bubble--comic .pt-bubble__files { color: #6b7694; margin-left: 6px; font-weight: 400; }
.pt-bubble--comic.pt-bubble--kind-reply {
  border-radius: 15px;
  padding: 10px 15px;
  line-height: 1.55;
  text-align: left;
}
.pt-bubble--comic.pt-bubble--kind-reply .pt-bubble__label {
  display: block;
  margin: 0 0 4px;
  font-size: 11px;
  letter-spacing: 0.04em;
}
.pt-bubble--comic.pt-bubble--kind-turn {
  background: #fff6df;
  border-radius: 15px;
  padding: 8px 16px;
}
.pt-bubble--comic.pt-bubble--kind-turn::before { content: '\\2713  '; color: #2f9e63; }

`,
  render: renderStandard,
})

registerBubbleStyle({
  id: 'memo',
  label: '便签',
  className: 'pt-bubble--memo',
  // The tilt lives on the individual `rotate` property, NOT `transform` —
  // the enter/exit keyframes own `transform` (and fill both), so a transform
  // tilt would be overridden forever. Trade-off: 飘落/随风 sway also animates
  // `rotate`, suppressing the tilt while they run; 弹出/升起/淡入/坠落 keep it.
  css: `
.pt-bubble--memo {
  rotate: -1.6deg;
  background: #fbf0c4;
  border: 1px solid rgba(122, 100, 44, 0.28);
  border-radius: 6px;
  color: #4d4433;
  font-family: 'Segoe Script', 'KaiTi', '楷体', cursive;
  font-size: 13px;
  line-height: 1.35;
  padding: 8px 12px 7px;
  box-shadow: 0 5px 14px rgba(120, 96, 40, 0.22);
}
.pt-bubble--memo::before {
  content: '';
  position: absolute;
  top: -7px;
  left: 50%;
  width: 46px;
  height: 15px;
  background: rgba(255, 255, 255, 0.5);
  box-shadow: 0 1px 3px rgba(120, 96, 40, 0.2);
  transform: translateX(-50%) rotate(-2.5deg);
}
.pt-bubble--memo .pt-bubble__label { color: #95834a; margin-right: 6px; }
.pt-bubble--memo .pt-bubble__timer,
.pt-bubble--memo .pt-bubble__lines { color: #a86e1f; font-weight: 700; font-variant-numeric: tabular-nums; }
.pt-bubble--memo .pt-bubble__files { color: #95834a; margin-left: 6px; }
.pt-bubble--memo.pt-bubble--kind-reply {
  border-radius: 8px;
  padding: 10px 14px;
  line-height: 1.6;
  text-align: left;
}
.pt-bubble--memo.pt-bubble--kind-reply .pt-bubble__label {
  display: block;
  margin: 0 0 4px;
  font-size: 11px;
}
.pt-bubble--memo.pt-bubble--kind-turn {
  border-radius: 8px;
  padding: 8px 14px;
}
.pt-bubble--memo.pt-bubble--kind-turn::before { content: '\\2714  '; color: #4e8d5b; }

`,
  render: renderStandard,
})

registerBubbleStyle({
  id: 'neon',
  label: '霓虹',
  className: 'pt-bubble--neon',
  css: `
.pt-bubble--neon {
  background: rgba(7, 12, 24, 0.78);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(94, 230, 255, 0.5);
  border-radius: 10px;
  color: #e9fbff;
  font-size: 13px;
  line-height: 1;
  padding: 6px 12px;
  box-shadow:
    0 0 10px rgba(94, 230, 255, 0.22),
    inset 0 0 12px rgba(94, 230, 255, 0.1),
    0 4px 18px rgba(0, 0, 0, 0.4);
}
.pt-bubble--neon .pt-bubble__label { color: #66d9f2; margin-right: 6px; text-shadow: 0 0 6px rgba(94, 230, 255, 0.45); }
.pt-bubble--neon .pt-bubble__timer,
.pt-bubble--neon .pt-bubble__lines { color: #8ef1ff; font-weight: 600; font-variant-numeric: tabular-nums; text-shadow: 0 0 7px rgba(94, 230, 255, 0.55); }
.pt-bubble--neon .pt-bubble__files { color: #66d9f2; margin-left: 6px; opacity: 0.8; }
.pt-bubble--neon.pt-bubble--kind-reply {
  border-radius: 12px;
  padding: 10px 14px;
  line-height: 1.55;
  text-align: left;
}
.pt-bubble--neon.pt-bubble--kind-reply .pt-bubble__label {
  display: block;
  margin: 0 0 4px;
  font-size: 11px;
  letter-spacing: 0.08em;
}
.pt-bubble--neon.pt-bubble--kind-turn {
  border-radius: 12px;
  padding: 8px 14px;
  border-color: rgba(94, 230, 255, 0.65);
}

`,
  render: renderStandard,
})

registerBubbleStyle({
  id: 'ink',
  label: '墨金',
  className: 'pt-bubble--ink',
  css: `
.pt-bubble--ink {
  background: #17181d;
  border: 1px solid rgba(198, 162, 102, 0.3);
  border-radius: 7px;
  color: #efe8da;
  font-family: Georgia, 'Times New Roman', 'SimSun', '宋体', serif;
  font-size: 13px;
  line-height: 1;
  padding: 6px 13px;
  box-shadow: inset 3px 0 0 0 #b28c4e, 0 4px 14px rgba(0, 0, 0, 0.35);
}
.pt-bubble--ink .pt-bubble__label { color: #c9a45c; margin-right: 7px; letter-spacing: 0.12em; }
.pt-bubble--ink .pt-bubble__timer,
.pt-bubble--ink .pt-bubble__lines { color: #f6efdd; font-weight: 600; font-variant-numeric: tabular-nums; }
.pt-bubble--ink .pt-bubble__files { color: #c9a45c; margin-left: 7px; opacity: 0.75; }
.pt-bubble--ink.pt-bubble--kind-reply {
  border-radius: 9px;
  padding: 10px 15px;
  line-height: 1.6;
  text-align: left;
}
.pt-bubble--ink.pt-bubble--kind-reply .pt-bubble__label {
  display: block;
  margin: 0 0 4px;
  font-size: 11px;
  letter-spacing: 0.16em;
}
.pt-bubble--ink.pt-bubble--kind-turn {
  border-radius: 9px;
  padding: 8px 16px;
  box-shadow:
    inset 3px 0 0 0 #b28c4e,
    inset 0 1px 0 0 rgba(198, 162, 102, 0.5),
    inset 0 -1px 0 0 rgba(198, 162, 102, 0.5),
    0 4px 14px rgba(0, 0, 0, 0.35);
}

`,
  render: renderStandard,
})
