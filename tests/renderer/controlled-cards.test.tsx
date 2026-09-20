// @vitest-environment jsdom
/**
 * controlled-cards.test.tsx — the Phase 18 settings-card contract: in-tree
 * companion cards are CONTROLLED components. They render `value`, report
 * full-bag edits through `onChange`, and never touch the network on their
 * own (the plugin page's 取消/应用 bar owns persistence). These tests pin
 * that seam so self-save cannot quietly creep back into a card.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoamerCard } from '../../src/renderer/companions/roamer/settings-card'
import { StatsHudCard } from '../../src/renderer/companions/stats-hud/settings-card'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let mounted: boolean

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = true
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const render = async (element: JSX.Element): Promise<void> => {
  await act(async () => {
    root.render(element)
  })
}

const checkboxByLabel = (text: string): HTMLInputElement => {
  const label = [...container.querySelectorAll('label')].find((l) => l.textContent?.includes(text))
  const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (input === null || input === undefined) throw new Error(`checkbox "${text}" missing`)
  return input
}

describe('RoamerCard (controlled)', () => {
  it('renders from value and reports toggles through onChange — never fetches', async () => {
    const onChange = vi.fn()
    await render(<RoamerCard value={{ wander: { enabled: true } }} onChange={onChange} />)
    expect(checkboxByLabel('游走').checked).toBe(true)

    act(() => checkboxByLabel('游走').click())
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]![0] as { wander?: { enabled?: boolean } }
    expect(next.wander?.enabled).toBe(false)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('renders defaults from an empty value bag without crashing', async () => {
    const onChange = vi.fn()
    await render(<RoamerCard value={undefined} onChange={onChange} />)
    expect(checkboxByLabel('待机动作').checked).toBe(true) // DEFAULT_IDLE.enabled
    act(() => checkboxByLabel('捣乱').click())
    const next = onChange.mock.calls[0]![0] as { mischief?: { enabled?: boolean } }
    expect(next.mischief?.enabled).toBe(false) // DEFAULT_MISCHIEF.enabled is true; the click turns it off
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('StatsHudCard (controlled)', () => {
  it('a style pick reports the migrated types bag through onChange — never fetches', async () => {
    const onChange = vi.fn()
    await render(<StatsHudCard value={{ columnGapPx: 24 }} onChange={onChange} />)

    // First select = 思考 styleId; pick the last listed style deterministically.
    const select = container.querySelector<HTMLSelectElement>('select')
    if (select === null) throw new Error('style select missing')
    const last = select.options[select.options.length - 1]!
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    if (setter === undefined) throw new Error('no native select value setter')
    act(() => {
      setter.call(select, last.value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]![0] as {
      columnGapPx?: number
      types?: Record<string, { styleId?: string }>
    }
    expect(next.columnGapPx).toBe(24) // untouched keys ride along
    expect(next.types?.thinking?.styleId).toBe(last.value)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
