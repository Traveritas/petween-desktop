/**
 * connectors/dialogue-text.ts — the reply-preview reduction shared by every
 * dialogue source (zcode rollout, Claude Code transcript, future Codex):
 * markdown stripping + single-lining + 160-char truncation. Privacy
 * invariant (docs/05 Phase 10 第二批): the reduction happens AT THE SOURCE —
 * only the truncated preview ever leaves main-side memory.
 */
export const DIALOGUE_MAX_CHARS = 160

/** Reply previews show PLAIN text — markdown markers would read as noise. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
}

export function truncatePreview(text: string): string {
  const single = stripMarkdown(text).replace(/\s+/g, ' ').trim()
  if (single.length <= DIALOGUE_MAX_CHARS) return single
  return `${single.slice(0, DIALOGUE_MAX_CHARS - 1).trimEnd()}…`
}
