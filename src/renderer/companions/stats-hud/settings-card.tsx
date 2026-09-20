/**
 * stats-hud/settings-card.tsx — the 插件 sub-page card for the stats bubble
 * HUD. A CONTROLLED component (Phase 18 settings rework): the shell page
 * owns the draft under companions.options['stats-hud'] and its 取消/应用 bar
 * does all persistence — this file owns nothing but DOM controls.
 *
 * Layout: behaviour toggles, then one row per bubble TYPE (思考/编辑/回复/
 * 完成) with its own style / enter / exit / hold picks — legacy flat keys
 * are migrated on read (migrateTypeConfigs) so old picks keep their look.
 */
import { type CSSProperties } from 'react'
import type { PluginSettingsCardProps } from '../registry'
import { listBubbleStyles } from '../bubbles/styles'
import { listBubbleEnterAnimations, listBubbleExitAnimations } from '../bubbles/animations'
import { DEFAULT_HUD_OPTIONS } from './hud-logic'
import { migrateTypeConfigs, type BubbleTypeKey } from './companion'

interface OptionBag {
  types?: Partial<Record<BubbleTypeKey, Record<string, unknown>>>
  multiSession?: boolean
  turnSummary?: boolean
  dialogue?: boolean
  milestoneEveryLines?: number
  columnGapPx?: number
  thinkingShowThresholdMs?: number
  editMaxAgeMs?: number
  [key: string]: unknown
}

const TYPE_LABELS: Record<BubbleTypeKey, string> = { thinking: '思考', edit: '编辑', reply: '回复', turn: '完成' }
const TYPE_ORDER: BubbleTypeKey[] = ['thinking', 'edit', 'reply', 'turn']

export function StatsHudCard(props: PluginSettingsCardProps): JSX.Element {
  const bag: OptionBag =
    typeof props.value === 'object' && props.value !== null ? (props.value as OptionBag) : {}
  // Legacy flat keys migrate on every read — a pure transform, cheap enough
  // per render and identical to what the overlay's options poll applies.
  const types = migrateTypeConfigs(bag)

  const patch = (next: Partial<OptionBag>): void => {
    props.onChange({ ...bag, ...next })
  }

  const patchType = (type: BubbleTypeKey, field: string, value: unknown): void => {
    const currentType = (bag.types?.[type] as Record<string, unknown> | undefined) ?? {}
    patch({ types: { ...(bag.types ?? {}), [type]: { ...currentType, [field]: value } } })
  }

  const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', flexWrap: 'wrap' }
  const selectStyle: CSSProperties = { flex: '0 0 auto' }
  const labelStyle: CSSProperties = { flex: '0 0 3em' }
  const numberStyle: CSSProperties = { width: 76 }

  const typeSelect = (
    type: BubbleTypeKey,
    field: 'styleId' | 'enterAnimationId' | 'exitAnimationId',
    options: Array<{ id: string; label: string }>,
  ): JSX.Element => (
    <select
      style={selectStyle}
      value={((types[type] as unknown as Record<string, unknown>)[field] as string | undefined) ?? ''}
      onChange={(event) => patchType(type, field, event.target.value === '' ? undefined : event.target.value)}
    >
      <option value="">默认</option>
      {options.map((entry) => (
        <option key={entry.id} value={entry.id}>
          {entry.label}
        </option>
      ))}
    </select>
  )

  return (
    <div>
      <div style={rowStyle}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={bag.multiSession ?? true} onChange={(event) => patch({ multiSession: event.target.checked })} />
          <span className="rowHint">多会话各一列</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={bag.turnSummary ?? true} onChange={(event) => patch({ turnSummary: event.target.checked })} />
          <span className="rowHint">完成提醒</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={bag.dialogue ?? true} onChange={(event) => patch({ dialogue: event.target.checked })} />
          <span className="rowHint">回复摘要</span>
        </label>
      </div>
      {TYPE_ORDER.map((type) => (
        <div key={type} style={rowStyle}>
          <span className="rowHint" style={labelStyle}>{TYPE_LABELS[type]}</span>
          {typeSelect(type, 'styleId', listBubbleStyles())}
          {typeSelect(type, 'enterAnimationId', listBubbleEnterAnimations())}
          {typeSelect(type, 'exitAnimationId', listBubbleExitAnimations())}
          <input
            type="number"
            min={0}
            step={200}
            style={numberStyle}
            value={types[type].holdMs}
            onChange={(event) => patchType(type, 'holdMs', Number(event.target.value))}
          />
          <span className="rowHint">ms 停留</span>
        </div>
      ))}
      <div style={rowStyle}>
        <span className="rowHint">列间距（px，相邻列边框最近距离）</span>
        <input type="number" min={0} max={200} step={4} style={numberStyle} value={bag.columnGapPx ?? 24} onChange={(event) => patch({ columnGapPx: Number(event.target.value) })} />
        <span className="rowHint">里程碑动画（每 N 新增行，0=关）</span>
        <input type="number" min={0} step={50} style={numberStyle} value={bag.milestoneEveryLines ?? 0} onChange={(event) => patch({ milestoneEveryLines: Number(event.target.value) })} />
      </div>
      <div style={rowStyle}>
        <span className="rowHint">思考显示阈值（ms，短于该时长的思考不弹泡）</span>
        <input type="number" min={0} step={100} style={numberStyle} value={bag.thinkingShowThresholdMs ?? DEFAULT_HUD_OPTIONS.thinkingShowThresholdMs} onChange={(event) => patch({ thinkingShowThresholdMs: Number(event.target.value) })} />
      </div>
      <p className="rowHint">四类泡泡各自独立设置样式、入场/出场动画与停留时长（思考/编辑为完成后停留；回复/完成为显示总时长）；改动对下一次弹出生效。</p>
    </div>
  )
}
