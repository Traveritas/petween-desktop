/**
 * roamer/settings-card.tsx — the 插件 sub-page card for the autonomous-
 * behavior companion. A CONTROLLED component (Phase 18 settings rework): the
 * shell page owns the draft under companions.options['roamer'] and its
 * 取消/应用 bar does all persistence — this file owns nothing but DOM
 * controls. It renders `value` and reports full-bag edits through
 * `onChange`; the only side effect left is the image upload action (asset
 * creation), whose resulting pool entry still flows back through onChange.
 */
import { useRef, type CSSProperties } from 'react'
import type { PluginSettingsCardProps } from '../registry'
import { DEFAULT_IDLE, DEFAULT_MISCHIEF, DEFAULT_WANDER } from './options'
import { type IdleActionId, type MischiefActionId, type PoseOverrideKey, type RoamerContentItem } from './types'

interface OptionBag {
  wander?: {
    enabled?: boolean
    when?: string
    speedPxPerSec?: number
    pauseMinMs?: number
    pauseMaxMs?: number
  }
  idle?: {
    enabled?: boolean
    actions?: Partial<Record<IdleActionId, boolean>>
    minIntervalMs?: number
    maxIntervalMs?: number
  }
  mischief?: {
    enabled?: boolean
    actions?: Partial<Record<MischiefActionId, boolean>>
    minIntervalMs?: number
    maxIntervalMs?: number
    pullLingerMs?: number
    noteLingerMs?: number
  }
  contentPool?: RoamerContentItem[]
  poses?: Partial<Record<PoseOverrideKey, string>>
  [key: string]: unknown
}

/** Per-action picture overrides: upload your own pet's variants. */
const POSE_LABELS: Record<PoseOverrideKey, string> = {
  walk: '走路',
  dash: '冲刺',
  doze: '打盹',
  lookAround: '张望',
  sway: '晃悠',
  shake: '抖毛',
  peek: '探头',
  pull: '拉窗',
  note: '便签',
}
const POSE_ORDER: PoseOverrideKey[] = ['walk', 'dash', 'doze', 'lookAround', 'sway', 'shake', 'peek', 'pull', 'note']

const IDLE_ACTION_LABELS: Record<IdleActionId, string> = {
  doze: '打盹',
  lookAround: '张望',
  sway: '晃悠',
  shake: '抖毛',
}
const IDLE_ACTION_ORDER: IdleActionId[] = ['doze', 'lookAround', 'sway', 'shake']

const MISCHIEF_ACTION_LABELS: Record<MischiefActionId, string> = {
  pullWindow: '拉内容窗',
  stickyNote: '贴便签',
  dashAcross: '冲过屏幕',
  edgePeek: '探头窥视',
}
const MISCHIEF_ACTION_ORDER: MischiefActionId[] = ['pullWindow', 'stickyNote', 'dashAcross', 'edgePeek']

export function RoamerCard(props: PluginSettingsCardProps): JSX.Element {
  const bag: OptionBag =
    typeof props.value === 'object' && props.value !== null ? (props.value as OptionBag) : {}
  // Async continuations (the image upload below) must read the LATEST bag —
  // the render-scope closure would roll back any edits made while the
  // upload was in flight.
  const bagRef = useRef(bag)
  bagRef.current = bag

  const patchWander = (field: string, value: unknown): void => {
    props.onChange({ ...bag, wander: { ...(bag.wander ?? {}), [field]: value } })
  }

  const patchIdle = (field: string, value: unknown): void => {
    props.onChange({ ...bag, idle: { ...(bag.idle ?? {}), [field]: value } })
  }

  const patchIdleAction = (action: IdleActionId, value: boolean): void => {
    patchIdle('actions', { ...(bag.idle?.actions ?? {}), [action]: value })
  }

  const patchMischief = (field: string, value: unknown): void => {
    props.onChange({ ...bag, mischief: { ...(bag.mischief ?? {}), [field]: value } })
  }

  const patchMischiefAction = (action: MischiefActionId, value: boolean): void => {
    patchMischief('actions', { ...(bag.mischief?.actions ?? {}), [action]: value })
  }

  const patchPool = (pool: RoamerContentItem[]): void => {
    props.onChange({ ...bag, contentPool: pool })
  }

  /** Upload through the petween asset pipeline, then append to the pool. */
  const addImage = (file: File): void => {
    const form = new FormData()
    form.append('file', file)
    void fetch('/api/petween/assets', { method: 'POST', body: form })
      .then((response) => (response.ok ? (response.json() as Promise<{ asset: { id: string; url: string } }>) : null))
      .then((body) => {
        if (body === null) return
        // Read through bagRef: the upload outlived this render, and any edits
        // made meanwhile must survive the append.
        const latest = bagRef.current
        props.onChange({
          ...latest,
          contentPool: [...(latest.contentPool ?? []), { id: `pool-${body.asset.id}`, kind: 'image', url: body.asset.url }],
        })
      })
      .catch(() => {})
  }

  const addText = (text: string): void => {
    const trimmed = text.trim()
    if (trimmed === '') return
    patchPool([...(bag.contentPool ?? []), { id: `pool-text-${Date.now()}`, kind: 'text', text: trimmed }])
  }

  /** Upload a per-action pose picture through the petween asset pipeline. */
  const setPose = (key: PoseOverrideKey, file: File): void => {
    const form = new FormData()
    form.append('file', file)
    void fetch('/api/petween/assets', { method: 'POST', body: form })
      .then((response) => (response.ok ? (response.json() as Promise<{ asset: { id: string; url: string } }>) : null))
      .then((body) => {
        if (body === null) return
        // bagRef: the upload outlived this render (same reasoning as addImage).
        props.onChange({ ...bagRef.current, poses: { ...(bagRef.current.poses ?? {}), [key]: body.asset.url } })
      })
      .catch(() => {})
  }

  const clearPose = (key: PoseOverrideKey): void => {
    const next = { ...(bag.poses ?? {}) }
    delete next[key]
    props.onChange({ ...bag, poses: next })
  }

  const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', flexWrap: 'wrap' }
  const labelStyle: CSSProperties = { flex: '0 0 3em' }
  const numberStyle: CSSProperties = { width: 76 }
  const wander = bag.wander ?? {}
  const wanderEnabled = wander.enabled ?? DEFAULT_WANDER.enabled
  const idle = bag.idle ?? {}
  const idleEnabled = idle.enabled ?? DEFAULT_IDLE.enabled

  return (
    <div>
      <div style={rowStyle}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={wanderEnabled}
            onChange={(event) => patchWander('enabled', event.target.checked)}
          />
          <span className="rowHint">游走</span>
        </label>
        <span className="rowHint">触发时机</span>
        <select
          value={wander.when ?? DEFAULT_WANDER.when}
          onChange={(event) => patchWander('when', event.target.value)}
        >
          <option value="idle-only">仅闲时</option>
          <option value="always">永远</option>
        </select>
        <span className="rowHint">速度（px/s）</span>
        <input
          type="number"
          min={5}
          max={600}
          step={5}
          style={numberStyle}
          value={wander.speedPxPerSec ?? DEFAULT_WANDER.speedPxPerSec}
          onChange={(event) => patchWander('speedPxPerSec', Number(event.target.value))}
        />
      </div>
      <div style={rowStyle}>
        <span className="rowHint" style={labelStyle}>休息</span>
        <input
          type="number"
          min={0}
          max={600000}
          step={500}
          style={numberStyle}
          value={wander.pauseMinMs ?? DEFAULT_WANDER.pauseMinMs}
          onChange={(event) => patchWander('pauseMinMs', Number(event.target.value))}
        />
        <span className="rowHint">至</span>
        <input
          type="number"
          min={0}
          max={600000}
          step={500}
          style={numberStyle}
          value={wander.pauseMaxMs ?? DEFAULT_WANDER.pauseMaxMs}
          onChange={(event) => patchWander('pauseMaxMs', Number(event.target.value))}
        />
        <span className="rowHint">ms（每段路程之间随机停留）</span>
      </div>
      <div style={rowStyle}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={idleEnabled}
            onChange={(event) => patchIdle('enabled', event.target.checked)}
          />
          <span className="rowHint">待机动作（静止时的小动作）</span>
        </label>
        {IDLE_ACTION_ORDER.map((action) => (
          <label key={action} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={bag.idle?.actions?.[action] ?? DEFAULT_IDLE.actions[action]}
              onChange={(event) => patchIdleAction(action, event.target.checked)}
            />
            <span className="rowHint">{IDLE_ACTION_LABELS[action]}</span>
          </label>
        ))}
      </div>
      <div style={rowStyle}>
        <span className="rowHint" style={labelStyle}>间隔</span>
        <input
          type="number"
          min={1000}
          max={3600000}
          step={1000}
          style={numberStyle}
          value={idle.minIntervalMs ?? DEFAULT_IDLE.minIntervalMs}
          onChange={(event) => patchIdle('minIntervalMs', Number(event.target.value))}
        />
        <span className="rowHint">至</span>
        <input
          type="number"
          min={1000}
          max={3600000}
          step={1000}
          style={numberStyle}
          value={idle.maxIntervalMs ?? DEFAULT_IDLE.maxIntervalMs}
          onChange={(event) => patchIdle('maxIntervalMs', Number(event.target.value))}
        />
        <span className="rowHint">ms（与游走共用触发时机）</span>
      </div>
      <div style={rowStyle}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={bag.mischief?.enabled ?? DEFAULT_MISCHIEF.enabled}
            onChange={(event) => patchMischief('enabled', event.target.checked)}
          />
          <span className="rowHint">捣乱</span>
        </label>
        {MISCHIEF_ACTION_ORDER.map((action) => (
          <label key={action} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={bag.mischief?.actions?.[action] ?? DEFAULT_MISCHIEF.actions[action]}
              onChange={(event) => patchMischiefAction(action, event.target.checked)}
            />
            <span className="rowHint">{MISCHIEF_ACTION_LABELS[action]}</span>
          </label>
        ))}
      </div>
      <div style={rowStyle}>
        <span className="rowHint" style={labelStyle}>间隔</span>
        <input
          type="number"
          min={5000}
          max={7200000}
          step={60000}
          style={numberStyle}
          value={bag.mischief?.minIntervalMs ?? DEFAULT_MISCHIEF.minIntervalMs}
          onChange={(event) => patchMischief('minIntervalMs', Number(event.target.value))}
        />
        <span className="rowHint">至</span>
        <input
          type="number"
          min={5000}
          max={7200000}
          step={60000}
          style={numberStyle}
          value={bag.mischief?.maxIntervalMs ?? DEFAULT_MISCHIEF.maxIntervalMs}
          onChange={(event) => patchMischief('maxIntervalMs', Number(event.target.value))}
        />
        <span className="rowHint">ms（拉窗与便签共用内容池）</span>
      </div>
      <div style={rowStyle}>
        <span className="rowHint" style={labelStyle}>停留</span>
        <span className="rowHint">拉窗</span>
        <input
          type="number"
          min={0.5}
          max={60}
          step={0.5}
          style={numberStyle}
          value={(bag.mischief?.pullLingerMs ?? DEFAULT_MISCHIEF.pullLingerMs) / 1000}
          onChange={(event) => patchMischief('pullLingerMs', Math.round(Number(event.target.value) * 1000))}
        />
        <span className="rowHint">s　便签</span>
        <input
          type="number"
          min={0.5}
          max={60}
          step={0.5}
          style={numberStyle}
          value={(bag.mischief?.noteLingerMs ?? DEFAULT_MISCHIEF.noteLingerMs) / 1000}
          onChange={(event) => patchMischief('noteLingerMs', Math.round(Number(event.target.value) * 1000))}
        />
        <span className="rowHint">s（0.5~60）</span>
      </div>
      {((bag.mischief?.pullLingerMs ?? DEFAULT_MISCHIEF.pullLingerMs) > 10000 ||
        (bag.mischief?.noteLingerMs ?? DEFAULT_MISCHIEF.noteLingerMs) > 10000) && (
        <p className="rowHint" style={{ color: '#b26a00', margin: '2px 0 6px' }}>
          ⚠ 停留超过 10 秒的窗口/便签可能较长时间遮挡屏幕内容，请注意别挡住常用区域。
        </p>
      )}
      <div style={rowStyle}>
        <span className="rowHint" style={labelStyle}>内容池</span>
        <label className="rowHint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          ＋图片
          <input
            type="file"
            accept="image/*"
            style={{ maxWidth: 180 }}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file !== undefined) addImage(file)
            }}
          />
        </label>
      </div>
      {(bag.contentPool ?? []).map((item, index) => (
        <div key={item.id} style={{ ...rowStyle, marginLeft: 12 }}>
          {item.kind === 'image' ? (
            <img src={item.url} alt="" style={{ maxWidth: 56, maxHeight: 40, objectFit: 'contain', borderRadius: 4 }} />
          ) : (
            <span className="rowHint" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.text}
            </span>
          )}
          <span className="rowHint">{item.kind === 'image' ? '图片' : '文本'}</span>
          <button type="button" onClick={() => patchPool((bag.contentPool ?? []).filter((_, i) => i !== index))}>
            删除
          </button>
        </div>
      ))}
      <div style={rowStyle}>
        <input
          type="text"
          placeholder="添加一条文本内容（回车确认）"
          style={{ flex: '1 1 auto', minWidth: 200 }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            const input = event.target as HTMLInputElement
            addText(input.value)
            input.value = ''
          }}
        />
      </div>
      <div style={rowStyle}>
        <span className="rowHint" style={labelStyle}>动作图片</span>
        <span className="rowHint">给各动作配你自己宠物的专属图（未配则用默认动画表现；冲刺未配时沿用走路图）</span>
      </div>
      {POSE_ORDER.map((key) => {
        const url = bag.poses?.[key]
        return (
          <div key={key} style={{ ...rowStyle, marginLeft: 12 }}>
            <span className="rowHint" style={{ flex: '0 0 3em' }}>{POSE_LABELS[key]}</span>
            {url !== undefined ? (
              <img src={url} alt="" style={{ maxWidth: 48, maxHeight: 40, objectFit: 'contain', borderRadius: 4 }} />
            ) : (
              <span className="rowHint" style={{ opacity: 0.55 }}>未设置</span>
            )}
            <label className="rowHint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {url !== undefined ? '更换' : '上传'}
              <input
                type="file"
                accept="image/*"
                style={{ maxWidth: 160 }}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file !== undefined) setPose(key, file)
                }}
              />
            </label>
            {url !== undefined && (
              <button type="button" onClick={() => clearPose(key)}>
                清除
              </button>
            )}
          </div>
        )
      })}
      <p className="rowHint">仅闲时=无 Agent 会话忙碌时才行动；永远=任何状态都行动（姿势仍显示工作状态）。拖住宠物会立即让它停下。</p>
    </div>
  )
}
