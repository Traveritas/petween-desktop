# zcode 连接器规格

第二个 Agent 状态源（继 DSH 桥之后）：把 zcode 客户端的 hooks 事件转成 petween 状态。
与 DSH 桥同层——main 进程事件源，经 `StateRelay`（docs/03 §1.4 的缝）喂
`normalizeSessionEvent` 既有链路，**petween 零改动**；两桥并存时按不同 sessionId
天然共存（aggregate 模式）。

调研记录见 docs/05「2026-09-18 zcode 连接器」节；本文件是实现规格。

## 1. 事件面与映射

zcode hooks（`~/.zcode/cli/config.json`，恰好七事件）→ 伪造 DSH 形状
`RawSessionEvent` 信封 → relay。**不解析 hook stdin**——事件种类编码在 URL 查询参数
（每事件一条 hook 注册），toolKind 分类编码在 PreToolUse 的三条 matcher 里，对
zcode 的唯一依赖是 `${CLAUDE_SESSION_ID}` 模板变量（以环境变量注入）。

| zcode hook | matcher | 连接器收到 | 伪造信封 | 宠物状态 |
|---|---|---|---|---|
| SessionStart | （省略） | `session-start` | `agent/status: idle` | 待机基线（resume 时清掉隔夜 success 残影） |
| UserPromptSubmit | （省略） | `user-prompt-submit` | `turn/start` + `assistant/chunk{reasoning-delta}` | 思考 |
| PreToolUse | `^(Edit\|Write\|ApplyPatch)$` | `pre-tool-edit` | `tool/call{name:'edit'}` | 工作（编辑） |
| PreToolUse | `^Bash$` | `pre-tool-command` | `tool/call{name:'bash'}` | 工作（命令） |
| PreToolUse | `^(?!(?:Edit\|Write\|ApplyPatch\|Bash)$)` | `pre-tool-other` | `tool/call{name:'read'}` | 工作（其他） |
| PostToolUse / PostToolUseFailure | （省略） | `post-tool` | `tool/result` | 回思考 |
| PermissionRequest | （省略） | `permission-request` | `approval/asked` | 等待 |
| Stop | （省略） | `stop` | `turn/end{reason:'completed'}` | 成功 |

已知缺口（v1 接受，见 §7）：
- **无 turn 级 error 事件**——Stop 无法区分成败，一律映射 success；工具失败
  （PostToolUseFailure）与成功同映射 `tool/result`（与 DSH「tool/result 不分成败」
  语义一致）。宠物 error 表情在该连接器下不可达。
- **无 SessionEnd**——会话清理走 §3 watchdog。

## 2. 传输与端口发现

```
zcode hooks ──(进程内联执行)──► curl.exe ──POST──► local-server /api/petween-desktop/connector/zcode/event?e=<kind>
                                              body: session=<CLAUDE_SESSION_ID>（urlencoded）
```

- **hook 形态**：`type:"process"`（argv、无 shell——Windows 最稳），command
  `curl.exe`（Win10+ 系统自带），args `--config <cfg> --data-urlencode
  session=${CLAUDE_SESSION_ID}`，`timeoutMs: 2500` 兜底。
- **端口发现 = curl cfg 文件**：local-server 端口随机，启动时把 8 份 cfg
  （每事件一份，含 `url`/`request`/`connect-timeout`/`max-time`/`noproxy`）重写到
  `userData/zcode-hooks/`。hook 注册里是**绝对 cfg 路径**（内容随端口变，注册一次永不
  过期）；安装/重装只在用户点按钮时发生。
- cfg 里 `noproxy = "*"`：防本机代理环境变量劫持 loopback POST；`connect-timeout=1`、
  `max-time=2` 把应用未运行时的最坏卡顿钳在秒级。
- **hooks 是内联执行的**（zcode 文档明说 async 无效）：实测热路径 ~50ms/次（进程
  spawn + loopback POST），可接受；应用关闭时 curl 连接失败——非 2 退出码在 zcode
  日志留 failed 记录（不阻塞会话，exit≠2 不 block）。见 §7 观察项。
- 本地 curl 无 `Origin` 头 → 既有跨源写栅栏放行（与 loopback 无鉴权同一边界，
  docs/05 安全节）；端点只读两个标量、无特权动作。

## 3. 连接器状态机与 watchdog

每个 session（`CLAUDE_SESSION_ID`，主会话 `sess_<uuid>`、子智能体
`sess_subagent_agent_<uuid>`——各自独立进 aggregate）：

- 事件到达 → 清该 session 全部计时器 → 按映射发射 → 按新状态重设：
  - `stop` 后 **60s** → `agent/status idle`（success 表情自然衰减回待机；DSH 里这个
    信号由真 agent 状态给，zcode 没有，连接器合成）。
  - `permission-request` 后 **10min** → idle（权限弹窗被搁置/消失时的解卡）。
  - 任意事件后 **30min** 无新事件 → `session/disposed`（内存回收 + 兜底解开
    「thinking/working 挂死」，如 zcode 崩溃）。长 Bash 工具远小于 30min，安全。
- thinking/working 不设短超时（工具可合法运行很久）。

## 4. 安装 / 卸载

写 `~/.zcode/cli/config.json`（用户作用域）：

- **合并写入，绝不整体覆盖**：读现有 JSON → 每事件数组先滤掉我们的条目（标记 =
  hook args 里含 cfgDir 路径）→ 追加我们的 → `hooks.enabled: true`（配置文件 hooks
  默认禁用，必须显式开）。mcp/plugins 等其他键原样保留。
- 卸载：滤掉我们的条目；events 全空则 `enabled: false`（等价出厂）。文件不存在 =
  已干净。
- 配置文件损坏（非法 JSON）→ 安装失败报错，**不覆盖**（那是用户数据）。
- **hooks 配置在 zcode 客户端启动时读取**（2026-09-18 spike 实测：运行中的客户端对
  新写入的用户级/工作区级配置均不拾取，新 spawn 的子会话也不行）→ 安装后需重启
  zcode 客户端生效。设置卡片上明示。

## 5. 设置与状态

- `desktop-settings.json` 新增 `connectors.zcode.enabled`（监听端点启停，默认 true；
  关闭时端点仍 204 但丢弃事件——hooks 残留也无害）。
- 设置页「连接」分区 zcode 卡片：启停开关 + 安装/移除 hooks 按钮 + 实时状态
  （hooks 是否已装、最近事件时间/种类、会话数）。
- 端点：`POST .../connector/zcode/event`（204 恒快返回）、
  `GET .../connector/zcode/status`、`POST .../connector/zcode/install`、
  `POST .../connector/zcode/uninstall`（后三者走跨源栅栏）。

## 6. 模块清单

| 文件 | 职责 |
|---|---|
| `src/main/connectors/zcode-connector.ts` | 事件 → relay 映射 + per-session watchdog（纯 Node） |
| `src/main/connectors/zcode-hooks.ts` | cfg 渲染/落盘 + zcode 配置安装/卸载/查询（纯 Node，路径注入） |
| `src/main/connectors/zcode-routes.ts` | 四个 HTTP 端点（table 注册，模式同 desktop-routes） |
| `src/main/index.ts` | 生命周期接线：boot 写 cfg、启停随设置 |
| `src/renderer/settings/main.tsx` | 连接分区 zcode 卡片 |

## 7. 观察项 / 已知风险（真机验证清单）

1. **matcher 锚定语义**：`^(?!...$)` 负向前瞻假设 zcode 用裸 `RegExp.test()`。
   若内部自行锚定（`^(?:matcher)$`），零宽断言只匹配空串 → 「其他」类工具永不触发
   （症状：Read/Grep 等工具期间宠物无工作表情）。修正=换省略 matcher 的单条通用
   注册（一行配置改动的重装）。Claude Code 兼容面（Task↔Agent 别名等）提示是裸
   test，但未实测。
2. **应用关闭时的 hook failed 日志噪音**：每工具调用一条 zcode 日志 failed 记录
   （curl 连接拒绝）。spike 沙箱里死端口表现为 1s 超时（RST 被沙箱吞），真机预计
   瞬时拒绝；若 zcode 对非 2 退出码有侵入式 UI 提示（未知），改用 `node -e`
   包装（恒 exit 0）或收紧 connect-timeout。
3. **Stop 是否在错误回合也触发**：是则错误回合宠物误现 success（v1 接受，无信号
   可分辨）。
4. 子智能体会话独立 sessionId，直接作为独立 session 进 aggregate——预期行为，
   真机确认无异常闪动即可。
