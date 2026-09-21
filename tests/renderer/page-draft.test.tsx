// @vitest-environment jsdom
/**
 * page-draft.test.tsx — usePageDraft, the heart of the Phase 18 per-page
 * 取消/应用 model. Pinned behaviors: load → baseline+draft; edits → dirty;
 * revert → back to baseline; edits made while an apply is in flight SURVIVE
 * the server echo (the v0.8.0 review's P1 fix); load failures surface after
 * the backoff budget and retryLoad recovers.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePageDraft, type PageApi } from '../../src/renderer/settings/page-draft'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Slice {
  value: number
}

let container: HTMLDivElement
let root: Root
let mounted: boolean
let api: { onDirtyChange: ReturnType<typeof vi.fn>; registerApply: ReturnType<typeof vi.fn> }

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = true
  api = { onDirtyChange: vi.fn(), registerApply: vi.fn() }
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

/** Renders the hook's state + control buttons into the DOM. */
function Harness(props: { load: () => Promise<Slice>; apply: (draft: Slice) => Promise<Slice> }): JSX.Element {
  const page = usePageDraft<Slice>({ load: props.load, apply: props.apply, api: api as unknown as PageApi })
  return (
    <div>
      <span className="h-draft">{page.draft === null ? 'null' : JSON.stringify(page.draft)}</span>
      <span className="h-dirty">{String(page.dirty)}</span>
      <span className="h-saving">{String(page.saving)}</span>
      <span className="h-error">{page.error ?? ''}</span>
      <button type="button" className="h-set" onClick={() => page.set({ value: 99 })}>
        set
      </button>
      <button type="button" className="h-revert" onClick={page.revert}>
        revert
      </button>
      <button type="button" className="h-apply" onClick={() => void page.apply()}>
        apply
      </button>
      <button type="button" className="h-retry" onClick={page.retryLoad}>
        retry
      </button>
    </div>
  )
}

const text = (selector: string): string => container.querySelector(selector)!.textContent ?? ''
const dirty = (): boolean => text('.h-dirty') === 'true'

const render = async (load: () => Promise<Slice>, apply: (draft: Slice) => Promise<Slice>): Promise<void> => {
  await act(async () => {
    root.render(<Harness load={load} apply={apply} />)
  })
}

describe('usePageDraft', () => {
  it('load resolves → baseline + draft, clean; onDirtyChange reported false', async () => {
    await render(async () => ({ value: 1 }), async (draft) => draft)
    expect(text('.h-draft')).toBe('{"value":1}')
    expect(dirty()).toBe(false)
    expect(api.onDirtyChange).toHaveBeenCalledWith(false)
  })

  it('set → dirty; revert → back to baseline and clean', async () => {
    await render(async () => ({ value: 1 }), async (draft) => draft)
    act(() => (container.querySelector('.h-set') as HTMLButtonElement).click())
    expect(text('.h-draft')).toBe('{"value":99}')
    expect(dirty()).toBe(true)
    expect(api.onDirtyChange).toHaveBeenCalledWith(true)
    act(() => (container.querySelector('.h-revert') as HTMLButtonElement).click())
    expect(text('.h-draft')).toBe('{"value":1}')
    expect(dirty()).toBe(false)
  })

  it('edits made while apply is in flight survive the server echo (still dirty)', async () => {
    let release: ((value: Slice) => void) | null = null
    const applied: Slice[] = []
    await render(
      async () => ({ value: 1 }),
      async (draft) => {
        applied.push(draft)
        return await new Promise<Slice>((resolve) => {
          release = resolve
        })
      },
    )
    act(() => (container.querySelector('.h-apply') as HTMLButtonElement).click())
    expect(text('.h-saving')).toBe('true')
    // The user keeps editing while the PUT is in flight.
    act(() => (container.querySelector('.h-set') as HTMLButtonElement).click())
    expect(text('.h-draft')).toBe('{"value":99}')
    // Server answers with the normalized echo of the SUBMITTED draft.
    await act(async () => {
      release?.({ value: 1 })
    })
    expect(text('.h-draft')).toBe('{"value":99}') // the in-flight edit survived
    expect(dirty()).toBe(true) // 99 against the fresh baseline {value:1}
    expect(text('.h-saving')).toBe('false')
    expect(applied).toEqual([{ value: 1 }])
  })

  it('a clean apply adopts the server-normalized result', async () => {
    await render(async () => ({ value: 1 }), async () => ({ value: 42 }) // server clamped/normalized
    )
    act(() => (container.querySelector('.h-set') as HTMLButtonElement).click())
    await act(async () => {
      ;(container.querySelector('.h-apply') as HTMLButtonElement).click()
    })
    expect(text('.h-draft')).toBe('{"value":42}')
    expect(dirty()).toBe(false)
  })

  it('load failures surface after the backoff budget; retryLoad recovers', async () => {
    vi.useFakeTimers()
    let fail = true
    const load = (): Promise<Slice> =>
      fail ? Promise.reject(new Error('boom')) : Promise.resolve({ value: 7 })
    await render(load, async (draft) => draft)
    // Burn the 5-attempt backoff budget (0.5+1+1.5+2s).
    for (const step of [500, 1000, 1500, 2000, 100]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(step)
      })
    }
    expect(text('.h-error')).toContain('boom')
    expect(text('.h-draft')).toBe('null')
    fail = false
    await act(async () => {
      ;(container.querySelector('.h-retry') as HTMLButtonElement).click()
    })
    expect(text('.h-draft')).toBe('{"value":7}')
    expect(text('.h-error')).toBe('')
    expect(dirty()).toBe(false)
  })
})
