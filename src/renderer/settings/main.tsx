/**
 * Desktop settings page (shell-owned renderer entry). Talks ONLY to the
 * /api/petween-desktop/* endpoints — no Electron IPC — so dev (vite proxy)
 * and prod (same-origin local-server) behave identically.
 *
 * Phase 18 settings rework:
 * - Navigation: 连接 / 宠物 / 交互 / 通用 on top, and an expandable 插件 group
 *   pinned at the BOTTOM with one sub-page per registered companion (each
 *   page: enable toggle + the companion's controlled SettingsCard, rendered
 *   even while disabled so it can be configured before enabling).
 * - Save model: every page owns its own draft of its settings slice plus a
 *   取消/应用 bar (Windows property-dialog semantics). Edits land in the
 *   draft only; 应用 PUTs the slice (server merges), 取消 reverts to the
 *   last applied baseline. Leaving a dirty page asks first
 *   (留下 / 丢弃更改并离开 / 保存并离开). Closing the window only hides it,
 *   so an unapplied draft survives until the app quits.
 * - The 宠物 section is the exception: the embedded petween editor keeps its
 *   own draft + explicit save (it stays mounted across section switches).
 * - Companions with a configStore (petween-physics) keep their persisted
 *   config OUTSIDE the settings document; their page loads/saves the bag
 *   through that store — same route the self-managed card used, so the
 *   overlay-side propagation story is unchanged.
 */
import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { DesktopSettings } from '../../main/desktop-settings'
import { listCompanions, type DesktopCompanion } from '../companions'
import { SettingsPage, type PageApi } from './page-draft'
import './settings.css'

/** A page id: a top section or `plugin:<companion id>`. */
type PageId = 'connect' | 'pet' | 'pointer' | 'general' | `plugin:${string}`

const TOP_SECTIONS: Array<{ id: PageId; label: string; hint: string }> = [
  { id: 'connect', label: '连接', hint: 'Agent 状态源' },
  { id: 'pet', label: '宠物', hint: '姿势 / 动画 / 预设' },
  { id: 'pointer', label: '交互', hint: '点击穿透与命中' },
  { id: 'general', label: '通用', hint: '启动与信息' },
]

type ConnectorUserSettings = DesktopSettings['connectors']['zcode']

interface StatusResponse {
  dsh: { enabled: boolean; connected: boolean; detail?: string }
  appVersion: string
  dataRoot: string
  serverOrigin: string
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (!response.ok) {
    // Surface the server's reason (install refusals, missing Node, …) —
    // a bare "HTTP 500" points the user at the wrong suspect.
    let message = `${path} -> HTTP ${response.status}`
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      if (typeof body.error?.message === 'string' && body.error.message !== '') message = body.error.message
    } catch {
      // non-JSON body — keep the status line
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}

async function getSettings(): Promise<DesktopSettings> {
  const body = await api<{ settings: DesktopSettings }>('/api/petween-desktop/settings')
  return body.settings
}

/** PUT a partial settings document; the server deep-merges per group/id. */
async function putSettings(patch: Record<string, unknown>): Promise<DesktopSettings> {
  const body = await api<{ settings: DesktopSettings }>('/api/petween-desktop/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
  return body.settings
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

interface ZcodeConnectorStatus {
  enabled: boolean
  hooksInstalled: boolean
  sessionsSeen: number
  lastEventAt: number | null
  lastKind: string | null
}

const HOOK_KIND_LABELS: Record<string, string> = {
  'session-start': '会话启动',
  'user-prompt-submit': '提交提示',
  'pre-tool-edit': '编辑工具',
  'pre-tool-command': '命令工具',
  'pre-tool-other': '其他工具',
  'post-tool': '工具结束',
  'permission-request': '等待授权',
  stop: '回合完成',
  'session-end': '会话结束',
}

function formatAge(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  return `${Math.round(seconds / 3600)} 小时前`
}

const CONNECTOR_TITLES: Record<'zcode' | 'cc' | 'codex', string> = {
  zcode: 'zcode',
  cc: 'Claude Code',
  codex: 'Codex',
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

function HookConnectorCard(props: {
  slug: 'zcode' | 'cc' | 'codex'
  connector: ConnectorUserSettings
  patch: (partial: Partial<ConnectorUserSettings>) => void
  /** Install-row copy: where the merge write goes + how it takes effect. */
  installHint: string
  installedHint: string
  /** Suffix note under the coverage line while no events have arrived yet. */
  idleNote: string
  /** Transport blurb under the coverage line (curl vs node sink). */
  transportNote: string
}): JSX.Element {
  const [status, setStatus] = useState<ZcodeConnectorStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const { slug, connector } = props
  const enabled = connector.enabled

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void api<ZcodeConnectorStatus>(`/api/petween-desktop/connector/${slug}/status`).then(
        (body) => {
          if (alive) setStatus(body)
        },
        () => {},
      )
    }
    load()
    const timer = setInterval(load, 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [slug])

  // Keep "N 秒前" labels ticking while a session is active.
  useEffect(() => {
    if (status?.lastEventAt === null || status?.lastEventAt === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [status?.lastEventAt])

  const runAction = (action: 'install' | 'uninstall'): void => {
    setBusy(action)
    setError(null)
    void api(`/api/petween-desktop/connector/${slug}/${action}`, { method: 'POST' }).then(
      async () => {
        setBusy(null)
        const body = await api<ZcodeConnectorStatus>(`/api/petween-desktop/connector/${slug}/status`).catch(() => null)
        if (body !== null) setStatus(body)
      },
      (e: unknown) => {
        setBusy(null)
        setError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  const stateText = !enabled
    ? '已停用'
    : status === null
      ? '…'
      : !status.hooksInstalled
        ? '未安装 hooks'
        : status.lastEventAt === null
          ? '已就绪（等待事件）'
          : `最近事件：${HOOK_KIND_LABELS[status.lastKind ?? ''] ?? status.lastKind}（${formatAge(status.lastEventAt, now)}）`

  return (
    <div className="connector">
      <div className="connectorHead">
        <span className={`dot ${enabled && status?.hooksInstalled ? 'on' : ''}`} />
        <strong>{CONNECTOR_TITLES[slug]}</strong>
        <span className="connectorState">{stateText}</span>
      </div>
      <Toggle
        label={`启用 ${CONNECTOR_TITLES[slug]} 连接器`}
        hint="接收 hooks 事件并驱动宠物状态（关闭后为纯监听不联动）；改动随页面底部的「应用」生效"
        checked={enabled}
        onChange={(next) => props.patch({ enabled: next })}
      />
      <Toggle
        label="只跟随最近交互的会话"
        hint="多会话时宠物只联动你最近提交过提示（或新开/恢复）的会话；后台会话不打扰表情"
        checked={connector.followLatestUser}
        onChange={(next) => props.patch({ followLatestUser: next })}
      />
      <div className="row">
        <span className="rowText">
          <span className="rowLabel">{status?.hooksInstalled ? '移除 hooks' : '安装 hooks'}</span>
          <span className="rowHint">{status?.hooksInstalled ? props.installedHint : props.installHint}</span>
        </span>
        <button type="button" disabled={busy !== null} onClick={() => runAction(status?.hooksInstalled ? 'uninstall' : 'install')}>
          {busy !== null ? '处理中…' : status?.hooksInstalled ? '移除' : '安装'}
        </button>
      </div>
      {status !== null && status.hooksInstalled && (
        <p className="sectionHint">
          已覆盖 {status.sessionsSeen} 个会话
          {status.lastEventAt === null ? props.idleNote : ''}
          {props.transportNote}
        </p>
      )}
      {error !== null && <p className="probeResult">{error}</p>}
    </div>
  )
}

interface ConnectSlice {
  dsh: DesktopSettings['dsh']
  connectors: DesktopSettings['connectors']
}

function ConnectPage(props: { api: PageApi; status: StatusResponse | null }): JSX.Element {
  return (
    <SettingsPage<ConnectSlice>
      title="Agent 状态源"
      hint="宠物根据已连接的 Agent 工具的会话状态切换表情；全部关闭时为纯桌宠模式（只有待机动画）。"
      load={async () => {
        const settings = await getSettings()
        return { dsh: settings.dsh, connectors: settings.connectors }
      }}
      apply={async (draft) => {
        const settings = await putSettings({ dsh: draft.dsh, connectors: draft.connectors })
        return { dsh: settings.dsh, connectors: settings.connectors }
      }}
      api={props.api}
    >
      {(draft, set) => <ConnectBody slice={draft} set={set} status={props.status} />}
    </SettingsPage>
  )
}

function ConnectBody(props: {
  slice: ConnectSlice
  set: (next: ConnectSlice) => void
  status: StatusResponse | null
}): JSX.Element {
  const [portDraft, setPortDraft] = useState(String(props.slice.dsh.port))
  // Follow external port changes (取消 revert / server normalization on
  // 应用) — typing never lands in slice.dsh.port until blur, so this only
  // fires on changes the input didn't make itself. Without it a cancelled
  // edit would sit in the box and re-enter the draft on the next blur.
  useEffect(() => {
    setPortDraft(String(props.slice.dsh.port))
  }, [props.slice.dsh.port])
  const [probe, setProbe] = useState<string | null>(null)
  const dsh = props.status?.dsh
  const patchConnector = (slug: 'zcode' | 'cc' | 'codex', partial: Partial<ConnectorUserSettings>): void => {
    props.set({
      ...props.slice,
      connectors: { ...props.slice.connectors, [slug]: { ...props.slice.connectors[slug], ...partial } },
    })
  }

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
    <>
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
          hint="关闭后宠物不联动 DSH（纯桌宠）；改动随页面底部的「应用」生效"
          checked={props.slice.dsh.enabled}
          onChange={(next) => props.set({ ...props.slice, dsh: { ...props.slice.dsh, enabled: next } })}
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
                if (Number.isInteger(port) && port >= 1 && port <= 65535 && port !== props.slice.dsh.port) {
                  props.set({ ...props.slice, dsh: { ...props.slice.dsh, port } })
                } else {
                  setPortDraft(String(props.slice.dsh.port))
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

      <HookConnectorCard
        slug="zcode"
        connector={props.slice.connectors.zcode}
        patch={(partial) => patchConnector('zcode', partial)}
        installHint="向 ~/.zcode/cli/config.json 合并写入 hook 注册；安装后需重启 zcode 客户端生效"
        installedHint="从 zcode 配置中移除 Petween 的 hook 注册（合并写入，不影响其他配置）"
        idleNote="（尚无事件——若刚安装，请重启 zcode 客户端）"
        transportNote="事件经本机 curl POST 直达，工具调用开销约 50ms。"
      />

      <HookConnectorCard
        slug="cc"
        connector={props.slice.connectors.cc}
        patch={(partial) => patchConnector('cc', partial)}
        installHint="向 ~/.claude/settings.json 合并写入 hook 注册；CC 会热加载，无需重启即生效"
        installedHint="从 Claude Code 配置中移除 Petween 的 hook 注册（合并写入，不影响其他配置）"
        idleNote="（尚无事件——CC 会热加载 settings.json，新会话即生效）"
        transportNote="事件经本机 curl POST 直达，工具调用开销约 50ms。"
      />

      <HookConnectorCard
        slug="codex"
        connector={props.slice.connectors.codex}
        patch={(partial) => patchConnector('codex', partial)}
        installHint="向 ~/.codex/hooks.json 合并写入 hook 注册（需要系统 Node.js）；Codex 会请求一次信任确认（hooks 哈希校验）"
        installedHint="从 Codex 配置中移除 Petween 的 hook 注册（合并写入，不影响其他配置）"
        idleNote="（尚无事件——若刚安装，请在 Codex 里确认信任新增 hooks 后开启新会话）"
        transportNote="事件经本机 node 进程直达（Codex 下 curl 不可用），开销约 100ms。"
      />

      <div className="connector placeholder">
        <div className="connectorHead">
          <span className="dot" />
          <strong>更多 Agent 工具</strong>
          <span className="connectorState">规划中</span>
        </div>
        <p className="sectionHint">opencode 等将按同一连接器架构加入（docs/06/07/08）。</p>
      </div>
    </>
  )
}

function PointerPage(props: { api: PageApi }): JSX.Element {
  return (
    <SettingsPage<DesktopSettings['clickThrough']>
      title="点击穿透"
      hint="默认自动：只有宠物本体响应鼠标，其余区域完全放行。异常时可切换强制模式或用救援热键。"
      load={async () => (await getSettings()).clickThrough}
      apply={async (draft) => (await putSettings({ clickThrough: draft })).clickThrough}
      api={props.api}
    >
      {(draft, set) => <PointerBody ct={draft} set={set} />}
    </SettingsPage>
  )
}

function PointerBody(props: { ct: DesktopSettings['clickThrough']; set: (next: DesktopSettings['clickThrough']) => void }): JSX.Element {
  const { ct } = props
  const patch = (partial: Partial<DesktopSettings['clickThrough']>): void => props.set({ ...ct, ...partial })
  return (
    <>
      <div className="modePicker">
        {(
          [
            ['auto', '自动', '按宠物区域命中切换（默认）'],
            ['always-through', '始终穿透', '宠物不可点击（完全放行鼠标）'],
          ] as const
        ).map(([value, label, hint]) => (
          <label key={value} className={`mode ${ct.mode === value ? 'active' : ''}`}>
            <input type="radio" name="ct-mode" checked={ct.mode === value} onChange={() => patch({ mode: value })} />
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
          onChange={(event) => patch({ hitPaddingPx: Number(event.target.value) })}
        />
      </div>

      <Toggle
        label="鼠标移动转发"
        hint="仅在宠物附近启用（约 96px 内）；关闭则全程只用光标轮询。转发用系统级鼠标钩子，已知的其他窗口光标闪烁问题只在钩子常驻时出现"
        checked={ct.forwardMouseMoves}
        onChange={(next) => patch({ forwardMouseMoves: next })}
      />
      <Toggle
        label="自愈"
        hint="睡眠恢复 / 崩溃 / 拖动后自动重新应用穿透状态"
        checked={ct.selfHealing}
        onChange={(next) => patch({ selfHealing: next })}
      />
      <Toggle
        label="救援热键"
        hint="按下在「锁定可交互 / 恢复自动」间切换（自动选用可用组合，默认 Ctrl+Alt+P）"
        checked={ct.rescueHotkeyEnabled}
        onChange={(next) => patch({ rescueHotkeyEnabled: next })}
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
    </>
  )
}

/** Crash isolation for a companion's settings card: one bad page ≠ dead app. */
class PluginCardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error('[petween-desktop] companion settings card crashed', error)
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="pluginCrash">
          <p className="sectionHint">此插件的设置界面出错了（不影响插件本身的运行）。</p>
          <button type="button" onClick={() => this.setState({ failed: false })}>
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

interface PluginSlice {
  enabled: boolean
  bag: unknown
}

function PluginPage(props: { companion: DesktopCompanion; api: PageApi }): JSX.Element {
  const { companion } = props
  return (
    <SettingsPage<PluginSlice>
      title={companion.displayName}
      hint={companion.description ?? companion.id}
      load={async () => {
        const settings = await getSettings()
        // A configStore companion keeps its bag OUT of the settings document.
        const bag =
          companion.configStore !== undefined
            ? await companion.configStore.load()
            : (settings.companions.options[companion.id] ?? {})
        return { enabled: settings.companions.enabled[companion.id] !== false, bag }
      }}
      apply={async (draft) => {
        // Own-store bag first: it is the sink most likely to reject
        // (validation), and a retry after a settings failure is idempotent.
        // The store resolves its normalized result — adopt it rather than
        // trusting the draft bag.
        let bag: unknown = draft.bag
        if (companion.configStore !== undefined) bag = await companion.configStore.save(draft.bag)
        const settings = await putSettings({
          companions: {
            enabled: { [companion.id]: draft.enabled },
            ...(companion.configStore === undefined ? { options: { [companion.id]: draft.bag } } : {}),
          },
        })
        return {
          enabled: settings.companions.enabled[companion.id] !== false,
          bag:
            companion.configStore !== undefined ? bag : (settings.companions.options[companion.id] ?? {}),
        }
      }}
      api={props.api}
    >
      {(draft, set) => (
        <PluginBody
          companion={companion}
          enabled={draft.enabled}
          bag={draft.bag}
          onEnabled={(enabled) => set({ ...draft, enabled })}
          onBag={(bag) => set({ ...draft, bag })}
        />
      )}
    </SettingsPage>
  )
}

function PluginBody(props: {
  companion: DesktopCompanion
  enabled: boolean
  bag: unknown
  onEnabled: (enabled: boolean) => void
  onBag: (bag: unknown) => void
}): JSX.Element {
  const Card = props.companion.SettingsCard
  return (
    <>
      <Toggle
        label="启用此插件"
        hint="关闭即时卸载（宠物侧行为立即停止），重新开启后立即挂载；改动随页面底部的「应用」生效"
        checked={props.enabled}
        onChange={props.onEnabled}
      />
      {Card !== undefined && (
        <PluginCardBoundary>
          {/* Settings stay visible while disabled — configure first, enable
              later; the shell owns persistence, the card is a pure control. */}
          <div className="companionCard">
            <Card value={props.bag} onChange={props.onBag} />
          </div>
        </PluginCardBoundary>
      )}
    </>
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
    <div className="page">
      <section className="card">
        <h2>通用</h2>
        {autoLaunch !== null && (
          <Toggle
            label="开机自启"
            hint="与托盘菜单中的开关是同一项（立即生效，不经过「应用」）"
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
    </div>
  )
}

function App(): JSX.Element {
  const [companions] = useState(() => listCompanions())
  const status = useStatus()
  const [active, setActive] = useState<PageId>('connect')
  const [pluginNavOpen, setPluginNavOpen] = useState(false)
  // The active page reports its draft state; navigation through a dirty page
  // goes through the guard overlay instead of switching directly.
  const [dirty, setDirty] = useState(false)
  const [pendingNav, setPendingNav] = useState<PageId | null>(null)
  const [guardSaving, setGuardSaving] = useState(false)
  const applyRef = useRef<(() => Promise<boolean>) | null>(null)

  const pageApi: PageApi = {
    onDirtyChange: setDirty,
    registerApply: (apply) => {
      applyRef.current = apply
    },
  }

  // Keep the ref stable for pages that inline it in their load/apply options
  // (usePageDraft reads everything through optionsRef anyway).
  const apiRef = useRef(pageApi)
  apiRef.current = pageApi

  const navigate = (target: PageId): void => {
    if (target === active) return
    if (dirty) setPendingNav(target)
    else setActive(target)
  }

  const confirmDiscard = (): void => {
    if (pendingNav === null) return
    const target = pendingNav
    setDirty(false)
    setPendingNav(null)
    setActive(target)
  }

  const confirmSaveAndLeave = async (): Promise<void> => {
    if (pendingNav === null) return
    const target = pendingNav
    const apply = applyRef.current
    if (apply === null) {
      setPendingNav(null)
      setActive(target)
      return
    }
    setGuardSaving(true)
    const ok = await apply()
    setGuardSaving(false)
    if (!ok) {
      setPendingNav(null) // stay here; the page's own bar shows the error
      return
    }
    // The page unmounts on switch — its dirty effect cannot report anymore,
    // so reset explicitly (same as confirmDiscard).
    setDirty(false)
    setPendingNav(null)
    setActive(target)
  }

  // Phase 11: open the standalone animator window (main-side capability;
  // failure is surfaced in the console — the window itself is the feedback).
  const openAnimator = (): void => {
    void api('/api/petween-desktop/open-animator', { method: 'POST' }).catch((error: unknown) =>
      console.error('open-animator failed', error),
    )
  }

  const activePluginId = active.startsWith('plugin:') ? active.slice('plugin:'.length) : null

  return (
    <div className="shell">
      <nav className="nav">
        {TOP_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className={active === section.id ? 'active' : ''}
            onClick={() => navigate(section.id)}
          >
            <span className="navLabel">{section.label}</span>
            <span className="navHint">{section.hint}</span>
          </button>
        ))}
        <div className="navSpacer" />
        <div className="pluginNav">
          <button
            type="button"
            className={`navGroup ${activePluginId !== null ? 'active' : ''}`}
            onClick={() => setPluginNavOpen((open) => !open)}
          >
            <span className="navLabel">
              插件<span className="navCaret">{pluginNavOpen ? '▾' : '▸'}</span>
            </span>
            <span className="navHint">伴生行为模块</span>
          </button>
          {pluginNavOpen &&
            companions.map((companion) => {
              const id: PageId = `plugin:${companion.id}`
              return (
                <button
                  key={companion.id}
                  type="button"
                  className={`navSub ${active === id ? 'active' : ''}`}
                  onClick={() => navigate(id)}
                >
                  <span className="navLabel">{companion.displayName}</span>
                </button>
              )
            })}
          {pluginNavOpen && companions.length === 0 && (
            <p className="navEmpty">当前构建中没有注册任何插件。</p>
          )}
        </div>
      </nav>
      <main className="content">
        {/* The pet section stays mounted (visibility toggling) so the embedded
            editor keeps its state and any dirty draft across section switches. */}
        <div className={`pane petPane ${active === 'pet' ? 'visible' : 'hidden'}`}>
          <div className="petToolbar">
            <span className="petToolbarHint">宠物 / 图片 / 姿势在此编辑；时间轴动画工作在独立窗口进行。</span>
            <button type="button" onClick={openAnimator}>
              ⏱ 打开动画编辑器
            </button>
          </div>
          {status !== null && (
            <iframe className="editorFrame" title="Petween 编辑器" src={`${status.serverOrigin}/petween-editor/`} />
          )}
        </div>
        {active === 'connect' && <ConnectPage api={apiRef.current} status={status} />}
        {active === 'pointer' && <PointerPage api={apiRef.current} />}
        {activePluginId !== null &&
          (() => {
            const companion = companions.find((c) => c.id === activePluginId)
            if (companion === undefined) return <div className="loading">未知插件：{activePluginId}</div>
            return <PluginPage key={companion.id} companion={companion} api={apiRef.current} />
          })()}
        {active === 'general' && <GeneralSection status={status} />}
        {pendingNav !== null && dirty && (
          <div className="navGuard">
            <span className="navGuardText">当前页面有未保存的更改</span>
            <span className="navGuardActions">
              <button type="button" onClick={() => setPendingNav(null)} disabled={guardSaving}>
                留下
              </button>
              <button type="button" onClick={confirmDiscard} disabled={guardSaving}>
                丢弃更改并离开
              </button>
              <button type="button" className="primary" onClick={() => void confirmSaveAndLeave()} disabled={guardSaving}>
                {guardSaving ? '保存中…' : '保存并离开'}
              </button>
            </span>
          </div>
        )}
      </main>
    </div>
  )
}

const container = document.getElementById('root')
if (container === null) throw new Error('petween-desktop: #root container missing')
createRoot(container).render(<App />)
