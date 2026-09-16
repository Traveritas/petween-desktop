/**
 * Desktop settings page (shell-owned renderer entry). Talks ONLY to the
 * /api/petween-desktop/* endpoints — no Electron IPC — so dev (vite proxy)
 * and prod (same-origin local-server) behave identically.
 *
 * Four sections: 连接 (agent state sources; DSH today, connector slots
 * later), 宠物 (the petween editor embedded in a same-origin iframe, kept
 * mounted so a dirty draft survives section switches), 交互 (click-through
 * behavior + rescue), 通用 (auto-launch, info).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { DesktopSettings } from '../../main/desktop-settings'
import { listCompanions } from '../companions'
import './settings.css'

type Section = 'connect' | 'pet' | 'pointer' | 'plugins' | 'general'

interface StatusResponse {
  dsh: { enabled: boolean; connected: boolean; detail?: string }
  appVersion: string
  dataRoot: string
  serverOrigin: string
}

const SECTIONS: Array<{ id: Section; label: string; hint: string }> = [
  { id: 'connect', label: '连接', hint: 'Agent 状态源' },
  { id: 'pet', label: '宠物', hint: '姿势 / 动画 / 预设' },
  { id: 'pointer', label: '交互', hint: '点击穿透与命中' },
  { id: 'plugins', label: '插件', hint: '伴生行为模块' },
  { id: 'general', label: '通用', hint: '启动与信息' },
]

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`)
  return (await response.json()) as T
}

function useSettings(): {
  settings: DesktopSettings | null
  patch: (patch: Partial<{ clickThrough: Partial<DesktopSettings['clickThrough']>; dsh: Partial<DesktopSettings['dsh']>; companions: Partial<DesktopSettings['companions']> }>) => void
} {
  const [settings, setSettings] = useState<DesktopSettings | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<Record<string, unknown>>({})
  const latest = useRef<DesktopSettings | null>(null)
  latest.current = settings

  useEffect(() => {
    void api<{ settings: DesktopSettings }>('/api/petween-desktop/settings').then(
      (body) => setSettings(body.settings),
      (error) => console.error('petween-desktop: settings load failed', error),
    )
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  const patch = useCallback((next: Record<string, unknown>) => {
    pending.current = { ...pending.current, ...next }
    // optimistic local apply so controls feel instant
    const optimistic = pending.current as {
      clickThrough?: Partial<DesktopSettings['clickThrough']>
      dsh?: Partial<DesktopSettings['dsh']>
      companions?: Partial<DesktopSettings['companions']>
    }
    if (latest.current !== null) {
      setSettings({
        ...latest.current,
        clickThrough: { ...latest.current.clickThrough, ...optimistic.clickThrough },
        dsh: { ...latest.current.dsh, ...optimistic.dsh },
        companions: { ...latest.current.companions, ...optimistic.companions },
      })
    }
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const body = pending.current
      pending.current = {}
      void api<{ settings: DesktopSettings }>('/api/petween-desktop/settings', {
        method: 'PUT',
        body: JSON.stringify(body),
      }).then(
        (result) => setSettings(result.settings),
        (error) => console.error('petween-desktop: settings save failed', error),
      )
    }, 300)
  }, [])

  return { settings, patch }
}

function useStatus(): StatusResponse | null {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  useEffect(() => {
    let alive = true
    const tick = (): void => {
      void api<StatusResponse>('/api/petween-desktop/status').then(
        (body) => {
          if (alive) setStatus(body)
        },
        () => {},
      )
    }
    tick()
    const timer = setInterval(tick, 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  return status
}

function Toggle(props: { checked: boolean; onChange: (next: boolean) => void; label: string; hint?: string }): JSX.Element {
  return (
    <label className="row">
      <span className="rowText">
        <span className="rowLabel">{props.label}</span>
        {props.hint !== undefined && <span className="rowHint">{props.hint}</span>}
      </span>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
    </label>
  )
}

function ConnectSection(props: { settings: DesktopSettings; patch: ReturnType<typeof useSettings>['patch']; status: StatusResponse | null }): JSX.Element {
  const [portDraft, setPortDraft] = useState(String(props.settings.dsh.port))
  const [probe, setProbe] = useState<string | null>(null)
  const dsh = props.status?.dsh

  const testPort = (): void => {
    setProbe('探测中…')
    void api<{ ok: boolean; version: string | null }>('/api/petween-desktop/dsh-test', {
      method: 'POST',
      body: JSON.stringify({ port: Number.parseInt(portDraft, 10) }),
    }).then(
      (body) => setProbe(body.ok ? `已连接（DSH ${body.version}）` : '该端口没有应答的 DSH'),
      () => setProbe('探测失败'),
    )
  }

  return (
    <section className="card">
      <h2>Agent 状态源</h2>
      <p className="sectionHint">宠物根据已连接的 Agent 工具的会话状态切换表情；全部关闭时为纯桌宠模式（只有待机动画）。</p>

      <div className="connector">
        <div className="connectorHead">
          <span className={`dot ${dsh?.connected ? 'on' : ''}`} />
          <strong>DSH</strong>
          <span className="connectorState">
            {!dsh ? '…' : !dsh.enabled ? '已停用' : dsh.connected ? '已连接' : `未连接${dsh.detail === undefined ? '' : `（${dsh.detail}）`}`}
          </span>
        </div>
        <Toggle
          label="启用 DSH 桥"
          hint="关闭后宠物不联动 DSH（纯桌宠）"
          checked={props.settings.dsh.enabled}
          onChange={(next) => props.patch({ dsh: { enabled: next } })}
        />
        <div className="row">
          <span className="rowText">
            <span className="rowLabel">端口</span>
            <span className="rowHint">dsh web 的端口（默认 3080，可用 --port 覆盖）</span>
          </span>
          <span className="portControls">
            <input
              className="portInput"
              type="number"
              min={1}
              max={65535}
              value={portDraft}
              onChange={(event) => setPortDraft(event.target.value)}
              onBlur={() => {
                const port = Number.parseInt(portDraft, 10)
                if (Number.isInteger(port) && port >= 1 && port <= 65535 && port !== props.settings.dsh.port) {
                  props.patch({ dsh: { port } })
                } else {
                  setPortDraft(String(props.settings.dsh.port))
                }
              }}
            />
            <button type="button" onClick={testPort}>
              测试
            </button>
          </span>
        </div>
        {probe !== null && <p className="probeResult">{probe}</p>}
      </div>

      <div className="connector placeholder">
        <div className="connectorHead">
          <span className="dot" />
          <strong>更多 Agent 工具</strong>
          <span className="connectorState">规划中</span>
        </div>
        <p className="sectionHint">Claude Code / Codex / opencode 等自定义接口将作为连接器加入这里。</p>
      </div>
    </section>
  )
}

function PointerSection(props: { settings: DesktopSettings; patch: ReturnType<typeof useSettings>['patch'] }): JSX.Element {
  const ct = props.settings.clickThrough
  return (
    <section className="card">
      <h2>点击穿透</h2>
      <p className="sectionHint">默认自动：只有宠物本体响应鼠标，其余区域完全放行。异常时可切换强制模式或用救援热键。</p>

      <div className="modePicker">
        {(
          [
            ['auto', '自动', '按宠物区域命中切换（默认）'],
            ['always-through', '始终穿透', '宠物不可点击（完全放行鼠标）'],
          ] as const
        ).map(([value, label, hint]) => (
          <label key={value} className={`mode ${ct.mode === value ? 'active' : ''}`}>
            <input
              type="radio"
              name="ct-mode"
              checked={ct.mode === value}
              onChange={() => props.patch({ clickThrough: { mode: value } })}
            />
            <span className="rowLabel">{label}</span>
            <span className="rowHint">{hint}</span>
          </label>
        ))}
      </div>

      <div className="row">
        <span className="rowText">
          <span className="rowLabel">命中区域外扩</span>
          <span className="rowHint">{ct.hitPaddingPx} px —— 数值越大越容易命中宠物（含防抖滞回）</span>
        </span>
        <input
          type="range"
          min={0}
          max={24}
          value={ct.hitPaddingPx}
          onChange={(event) => props.patch({ clickThrough: { hitPaddingPx: Number(event.target.value) } })}
        />
      </div>

      <Toggle
        label="鼠标移动转发"
        hint="关闭则仅用光标轮询（其他应用拖动窗口闪烁时可关闭）"
        checked={ct.forwardMouseMoves}
        onChange={(next) => props.patch({ clickThrough: { forwardMouseMoves: next } })}
      />
      <Toggle
        label="自愈"
        hint="睡眠恢复 / 崩溃 / 拖动后自动重新应用穿透状态"
        checked={ct.selfHealing}
        onChange={(next) => props.patch({ clickThrough: { selfHealing: next } })}
      />
      <Toggle
        label="救援热键"
        hint="按下在「锁定可交互 / 恢复自动」间切换（自动选用可用组合，默认 Ctrl+Alt+P）"
        checked={ct.rescueHotkeyEnabled}
        onChange={(next) => props.patch({ clickThrough: { rescueHotkeyEnabled: next } })}
      />

      <div className="row">
        <span className="rowText">
          <span className="rowLabel">立即修复交互</span>
          <span className="rowHint">强制重新应用穿透状态（不改任何设置）</span>
        </span>
        <button
          type="button"
          onClick={() => {
            void api('/api/petween-desktop/fix-interaction', { method: 'POST' }).catch(() => {})
          }}
        >
          执行
        </button>
      </div>
    </section>
  )
}

function PluginsSection(props: { settings: DesktopSettings; patch: ReturnType<typeof useSettings>['patch'] }): JSX.Element {
  const companions = listCompanions()
  return (
    <section className="card">
      <h2>插件</h2>
      <p className="sectionHint">伴生行为模块（运行在宠物旁，如投掷物理）。关闭即时生效，重新开启后立即挂载。</p>
      {companions.length === 0 && <p className="sectionHint">当前构建中没有注册任何插件。</p>}
      {companions.map((companion) => {
        const enabled = props.settings.companions.enabled[companion.id] !== false
        const Card = companion.SettingsCard
        return (
          <div key={companion.id} className="companionBlock">
            <Toggle
              label={companion.displayName}
              hint={companion.description ?? companion.id}
              checked={enabled}
              onChange={(next) =>
                props.patch({ companions: { enabled: { ...props.settings.companions.enabled, [companion.id]: next } } })
              }
            />
            {enabled && Card !== undefined && (
              <div className="companionCard">
                <Card />
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}

function GeneralSection(props: { status: StatusResponse | null }): JSX.Element {
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null)
  useEffect(() => {
    void api<{ enabled: boolean }>('/api/petween-desktop/autolaunch').then(
      (body) => setAutoLaunch(body.enabled),
      () => {},
    )
  }, [])
  return (
    <section className="card">
      <h2>通用</h2>
      {autoLaunch !== null && (
        <Toggle
          label="开机自启"
          hint="与托盘菜单中的开关是同一项"
          checked={autoLaunch}
          onChange={(next) => {
            setAutoLaunch(next)
            void api('/api/petween-desktop/autolaunch', { method: 'PUT', body: JSON.stringify({ enabled: next }) }).catch(() => {})
          }}
        />
      )}
      <dl className="infoList">
        <dt>版本</dt>
        <dd>{props.status?.appVersion ?? '…'}</dd>
        <dt>数据目录</dt>
        <dd className="path">{props.status?.dataRoot ?? '…'}</dd>
      </dl>
    </section>
  )
}

function App(): JSX.Element {
  const { settings, patch } = useSettings()
  const status = useStatus()
  const [active, setActive] = useState<Section>('connect')

  if (settings === null) {
    return <div className="loading">加载设置…</div>
  }

  return (
    <div className="shell">
      <nav className="nav">
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className={active === section.id ? 'active' : ''}
            onClick={() => setActive(section.id)}
          >
            <span className="navLabel">{section.label}</span>
            <span className="navHint">{section.hint}</span>
          </button>
        ))}
      </nav>
      <main className="content">
        {/* The pet section stays mounted (visibility toggling) so the embedded
            editor keeps its state and any dirty draft across section switches. */}
        <div className={`pane ${active === 'pet' ? 'visible' : 'hidden'}`}>
          {status !== null && (
            <iframe className="editorFrame" title="Petween 编辑器" src={`${status.serverOrigin}/petween-editor/`} />
          )}
        </div>
        {active === 'connect' && <ConnectSection settings={settings} patch={patch} status={status} />}
        {active === 'pointer' && <PointerSection settings={settings} patch={patch} />}
        {active === 'plugins' && <PluginsSection settings={settings} patch={patch} />}
        {active === 'general' && <GeneralSection status={status} />}
      </main>
    </div>
  )
}

const container = document.getElementById('root')
if (container === null) throw new Error('petween-desktop: #root container missing')
createRoot(container).render(<App />)
