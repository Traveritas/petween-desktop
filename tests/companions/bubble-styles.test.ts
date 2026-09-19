/**
 * Bubble style registry (v0.3.15 batch): the four new skins (comic/memo/
 * neon/ink) register alongside the built-ins and stay CSS-only — every skin
 * renders through the shared renderStandard, so the host's render contract
 * (timer/lines/turn/reply hooks) holds for all of them. The render output
 * and the CSS looks are verified visually (headless-browser harness), not in
 * unit tests — this file only pins the registry surface.
 */
import { describe, expect, it } from 'vitest'
import { getBubbleStyle, listBubbleStyles } from '../../src/renderer/companions/bubbles/styles'

describe('bubble style registry (v0.3.15)', () => {
  it('registers the four new skins with non-empty labels, class names and css', () => {
    const ids = listBubbleStyles().map((style) => style.id)
    for (const id of ['comic', 'memo', 'neon', 'ink']) {
      expect(ids, id).toContain(id)
      const style = getBubbleStyle(id)
      expect(style.label.length).toBeGreaterThan(0)
      expect(style.className).toBe(`pt-bubble--${id}`)
      expect(style.css ?? '').toContain(style.className)
    }
  })

  it('falls back to the first style for unknown ids', () => {
    expect(getBubbleStyle('does-not-exist').id).toBe(listBubbleStyles()[0].id)
  })
})
