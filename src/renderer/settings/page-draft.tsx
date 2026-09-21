/**
 * settings/page-draft.tsx — the per-page draft machinery behind the 设置窗's
 * 取消/应用 bars (Phase 18). Extracted from main.tsx so the hook and page
 * shell are importable by tests (the entry file mounts React at import time
 * and cannot be loaded by vitest).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { jsonDeepEqual } from './draft'

/** The handle a page registers with the App for the leave-dirty guard. */
export interface PageApi {
  onDirtyChange(dirty: boolean): void
  registerApply(apply: (() => Promise<boolean>) | null): void
}

export interface PageDraft<T> {
  draft: T | null
  dirty: boolean
  saving: boolean
  error: string | null
  set(next: T): void
  revert(): void
  apply(): Promise<boolean>
  retryLoad(): void
}

/**
 * One page's draft lifecycle: load (with backoff retry) → baseline + draft;
 * edits only touch the draft; apply() commits through the caller's sink and
 * adopts the server-normalized result as the new baseline.
 */
export function usePageDraft<T>(options: {
  load: () => Promise<T>
  /** Commits the draft; resolves to the fresh baseline (server-normalized). */
  apply: (draft: T) => Promise<T>
  api: PageApi
}): PageDraft<T> {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [baseline, setBaseline] = useState<T | null>(null)
  const baselineRef = useRef<T | null>(null)
  baselineRef.current = baseline
  const [draft, setDraft] = useState<T | null>(null)
  const draftRef = useRef<T | null>(null)
  draftRef.current = draft
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadSeq, setReloadSeq] = useState(0)

  useEffect(() => {
    let alive = true
    let attempt = 0
    const run = (): void => {
      void optionsRef.current.load().then(
        (value) => {
          if (!alive) return
          setBaseline(value)
          setDraft(structuredClone(value))
          setError(null)
        },
        (loadError: unknown) => {
          if (!alive) return
          attempt += 1
          // A stuck "加载中…" page helps nobody — retry with backoff, then
          // surface the reason in the draft bar (with a 重试 button).
          if (attempt < 5) {
            setTimeout(run, 500 * attempt)
            return
          }
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        },
      )
    }
    run()
    return () => {
      alive = false
    }
  }, [reloadSeq])

  const set = useCallback((next: T): void => setDraft(next), [])

  const revert = useCallback((): void => {
    if (baselineRef.current !== null) setDraft(structuredClone(baselineRef.current))
  }, [])

  const apply = useCallback(async (): Promise<boolean> => {
    if (draft === null || saving) return false
    const submitted = draft
    setSaving(true)
    setError(null)
    try {
      const fresh = await optionsRef.current.apply(submitted)
      setBaseline(fresh)
      // Edits made while this apply was in flight outrank the server echo —
      // adopt the normalized result only when the draft is untouched; a new
      // draft object stays (still dirty against the fresh baseline). The old
      // debounced sender merged queued edits the same way.
      if (draftRef.current === submitted) setDraft(structuredClone(fresh))
      return true
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError))
      return false
    } finally {
      setSaving(false)
    }
  }, [draft, saving])

  const dirty = draft !== null && baseline !== null && !jsonDeepEqual(draft, baseline)

  useEffect(() => {
    optionsRef.current.api.onDirtyChange(dirty)
  }, [dirty])

  useEffect(() => {
    const { registerApply } = optionsRef.current.api
    registerApply(apply)
    return () => registerApply(null)
  }, [apply])

  return { draft, dirty, saving, error, set, revert, apply, retryLoad: () => setReloadSeq((n) => n + 1) }
}

export function DraftBar(props: {
  dirty: boolean
  saving: boolean
  error: string | null
  loadFailed: boolean
  onApply: () => void
  onRevert: () => void
  onRetry: () => void
}): JSX.Element {
  const state = props.loadFailed
    ? `加载失败：${props.error ?? '未知错误'}`
    : props.saving
      ? '正在保存…'
      : props.error !== null
        ? `保存失败：${props.error}`
        : props.dirty
          ? '有未保存的更改'
          : '更改将在点击「应用」后生效'
  return (
    <div className="draftBar">
      <span className={`draftState ${props.error !== null ? 'error' : ''}`}>{state}</span>
      {props.loadFailed ? (
        <button type="button" onClick={props.onRetry}>
          重试
        </button>
      ) : (
        <span className="draftActions">
          <button type="button" disabled={!props.dirty || props.saving} onClick={props.onRevert}>
            取消
          </button>
          <button type="button" className="primary" disabled={!props.dirty || props.saving} onClick={props.onApply}>
            应用
          </button>
        </span>
      )}
    </div>
  )
}

/**
 * The shell every draftable page renders into: card + draft bar. Children
 * only mount once the slice has loaded, so their hooks see a real draft.
 */
export function SettingsPage<T>(props: {
  title: string
  hint?: string
  load: () => Promise<T>
  apply: (draft: T) => Promise<T>
  api: PageApi
  children: (draft: T, set: (next: T) => void) => ReactNode
}): JSX.Element {
  const page = usePageDraft<T>({ load: props.load, apply: props.apply, api: props.api })
  return (
    <div className="page">
      <section className="card">
        <h2>{props.title}</h2>
        {props.hint !== undefined && <p className="sectionHint">{props.hint}</p>}
        {page.draft === null ? (
          <p className="sectionHint">{page.error !== null ? '该页设置未能加载。' : '加载中…'}</p>
        ) : (
          props.children(page.draft, page.set)
        )}
      </section>
      <DraftBar
        dirty={page.dirty}
        saving={page.saving}
        error={page.error}
        loadFailed={page.draft === null && page.error !== null}
        onApply={() => void page.apply()}
        onRevert={page.revert}
        onRetry={page.retryLoad}
      />
    </div>
  )
}
