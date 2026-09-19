/**
 * stats-hud/settings-card.tsx — the 插件 section card for the stats bubble
 * HUD (Phase 10). Owns nothing but the DOM controls: it reads the option bag
 * the shell stores under companions.options['stats-hud'] and PUTs patches
 * back through /api/petween-desktop/settings (the same transport every other
 * settings control uses — no companion-specific endpoints).
 *
 * The overlay picks changes up on its 3s options poll; bubbles in flight
 * keep their current skin until the next spawn.
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { listBubbleStyles } from '../bubbles/styles'
import { listBubbleEnterAnimations, listBubbleExitAnimations } from '../bubbles/animations'
import { DEFAULT_HUD_OPTIONS } from './hud-logic'
import { STATS_HUD_ID } from './companion'

interface OptionBag {
  styleId?: string
  enterAnimationId?: string
  exitAnimationId?: string
  thinkingShowThresholdMs?: number
  thinkingHoldMs?: number
  editHoldMs?: number
  editMaxAgeMs?: number
}

const DEFAULTS: Required<Omit<OptionBag, 'styleId' | 'enterAnimationId' | 'exitAnimationId'>> = {
  thinkingShowThresholdMs: DEFAULT_HUD_OPTIONS.thinkingShowThresholdMs,
  thinkingHoldMs: DEFAULT_HUD_OPTIONS.thinkingHoldMs,
  editHoldMs: DEFAULT_HUD_OPTIONS.editHoldMs,
  editMaxAgeMs: DEFAULT_HUD_OPTIONS.editMaxAgeMs,
}

export function StatsHudCard(): JSX.Element {
  const [bag, setBag] = useState<OptionBag | null>(null)

  useEffect(() => {
    let alive = true
    void fetch('/api/petween-desktop/settings')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { settings?: { companions?: { options?: Record<string, unknown> } } } | null) => {
        if (!alive || body === null) return
        const raw = body.settings?.companions?.options?.[STATS_HUD_ID]
        setBag(typeof raw === 'object' && raw !== null ? (raw as OptionBag) : {})
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const patch = (next: OptionBag): void => {
    setBag((current) => ({ ...(current ?? {}), ...next }))
    void fetch('/api/petween-desktop/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companions: { options: { [STATS_HUD_ID]: { ...(bag ?? {}), ...next } } } }),
    }).catch(() => {})
  }

  if (bag === null) return <p className="rowHint">加载中…</p>

  const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }
  const selectStyle: CSSProperties = { flex: '0 0 auto' }

  return (
    <div>
      <div style={rowStyle}>
        <span className="rowHint">泡泡样式</span>
        <select
          style={selectStyle}
          value={bag.styleId ?? ''}
          onChange={(event) => patch({ styleId: event.target.value === '' ? undefined : event.target.value })}
        >
          <option value="">默认（{listBubbleStyles()[0]?.label ?? '玻璃'}）</option>
          {listBubbleStyles().map((style) => (
            <option key={style.id} value={style.id}>
              {style.label}
            </option>
          ))}
        </select>
        <span className="rowHint">入场</span>
        <select
          style={selectStyle}
          value={bag.enterAnimationId ?? ''}
          onChange={(event) => patch({ enterAnimationId: event.target.value === '' ? undefined : event.target.value })}
        >
          <option value="">默认（{listBubbleEnterAnimations()[0]?.label ?? '弹出'}）</option>
          {listBubbleEnterAnimations().map((animation) => (
            <option key={animation.id} value={animation.id}>
              {animation.label}
            </option>
          ))}
        </select>
        <span className="rowHint">出场</span>
        <select
          style={selectStyle}
          value={bag.exitAnimationId ?? ''}
          onChange={(event) => patch({ exitAnimationId: event.target.value === '' ? undefined : event.target.value })}
        >
          <option value="">默认（{listBubbleExitAnimations()[0]?.label ?? '淡出'}）</option>
          {listBubbleExitAnimations().map((animation) => (
            <option key={animation.id} value={animation.id}>
              {animation.label}
            </option>
          ))}
        </select>
      </div>
      <div style={rowStyle}>
        <span className="rowHint">思考显示阈值（ms，短于该时长的思考不弹泡）</span>
        <input
          type="number"
          min={0}
          step={100}
          value={bag.thinkingShowThresholdMs ?? DEFAULTS.thinkingShowThresholdMs}
          onChange={(event) => patch({ thinkingShowThresholdMs: Number(event.target.value) })}
          style={{ width: 90 }}
        />
      </div>
      <div style={rowStyle}>
        <span className="rowHint">完成后停留（ms，淡出前展示最终数值）</span>
        <input
          type="number"
          min={0}
          step={100}
          value={bag.editHoldMs ?? DEFAULTS.editHoldMs}
          onChange={(event) => patch({ editHoldMs: Number(event.target.value) })}
          style={{ width: 90 }}
        />
      </div>
      <p className="rowHint">行数与思考数据来自 zcode 连接器的 hook 载荷；更新样式对进行中的泡泡在下一次弹出时生效。</p>
    </div>
  )
}
