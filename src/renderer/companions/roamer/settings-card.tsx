/**
 * roamer/settings-card.tsx — the 插件 section card for the autonomous-
 * behavior companion. Owns nothing but DOM controls: reads the option bag
 * the shell stores under companions.options['roamer'] and PUTs merged bags
 * back through /api/pween-desktop/settings (the transport every other
 * settings control uses). Batch 1 ships the wander section; idle-action
 * and mischief sections land with their engine batches (2/3) — toggles
 * only appear once they do something.
 *
 * Same discipline as StatsHudCard: no props, fetch on mount, side effects
 * never inside setState updaters (StrictMode double-invokes them).
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { DEFAULT_IDLE, DEFAULT_WANDER } from './options'
import { ROAMER_ID, type IdleActionId } from './types'

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
  [key: string]: unknown
}

const IDLE_ACTION_LABELS: Record<IdleActionId, string> = {
  doze: '打盹',
  lookAround: '张望',
  sway: '晃悠',
  shake: '抖毛',
}
const IDLE_ACTION_ORDER: IdleActionId[] = ['doze', 'lookAround', 'sway', 'shake']

export function RoamerCard(): JSX.Element {
  const [bag, setBag] = useState<OptionBag | null>(null)

  useEffect(() => {
    let alive = true
    void fetch('/api/petween-desktop/settings')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { settings?: { companions?: { options?: Record<string, unknown> } } } | null) => {
        if (!alive || body === null) return
        const raw = body.settings?.companions?.options?.[ROAMER_ID]
        setBag(typeof raw === 'object' && raw !== null ? (raw as OptionBag) : {})
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const patchWander = (field: string, value: unknown): void => {
    const merged: OptionBag = {
      ...(bag ?? {}),
      wander: { ...(bag?.wander ?? {}), [field]: value },
    }
    setBag(merged)
    void fetch('/api/petween-desktop/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companions: { options: { [ROAMER_ID]: merged } } }),
    }).catch(() => {})
  }

  const patchIdle = (field: string, value: unknown): void => {
    const merged: OptionBag = {
      ...(bag ?? {}),
      idle: { ...(bag?.idle ?? {}), [field]: value },
    }
    setBag(merged)
    void fetch('/api/petween-desktop/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companions: { options: { [ROAMER_ID]: merged } } }),
    }).catch(() => {})
  }

  const patchIdleAction = (action: IdleActionId, value: boolean): void => {
    patchIdle('actions', { ...(bag?.idle?.actions ?? {}), [action]: value })
  }

  if (bag === null) return <p className="rowHint">加载中…</p>

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
      <p className="rowHint">仅闲时=无 Agent 会话忙碌时才行动；永远=任何状态都行动（姿势仍显示工作状态）。拖住宠物会立即让它停下。</p>
    </div>
  )
}
