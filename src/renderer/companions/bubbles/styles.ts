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
`,
  render(el, content) {
    if (content.kind === 'thinking') renderThinking(el, content)
    else if (content.kind === 'turn') renderTurn(el, content)
    else if (content.kind === 'reply') renderReply(el, content)
    else renderEdit(el, content)
  },
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
`,
  render(el, content) {
    if (content.kind === 'thinking') renderThinking(el, content)
    else if (content.kind === 'turn') renderTurn(el, content)
    else if (content.kind === 'reply') renderReply(el, content)
    else renderEdit(el, content)
  },
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
`,
  render(el, content) {
    if (content.kind === 'thinking') renderThinking(el, content)
    else if (content.kind === 'turn') renderTurn(el, content)
    else if (content.kind === 'reply') renderReply(el, content)
    else renderEdit(el, content)
  },
})
