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

### 3.1 跟随模式（followLatestUser，默认关）

多 zcode 窗口并开时，§14.5 aggregate 会把所有会话搅在一起。zcode 没有窗口焦点
信号，焦点代理 = **用户主动事件**（`user-prompt-submit` / `session-start`——只在
用户正打字的窗口发生）。开启后：

- 后台会话事件照常记账（watchdog、lastKind）但**不发射**；
- 焦点切换到新会话时：旧目标补发一条 `agent/status idle`（rank 0 替换其在
  aggregate 的槽位，不再压制新目标）+ 新目标**重放**其最后视觉状态（宠物立即切换，
  不等它的下一个事件；重放用 chunk 而非 turn/start——视觉等价）；
- 尚无任何焦点信号前事件照常透传（等价 aggregate）；目标被 30min 静默 disposed 后
  清空，等待下一次焦点信号；关闭开关立即恢复 aggregate。
- 已知取舍：后台会话的 `permission-request` 被门控（不弹等待表情）——它是被动信号，
  不能当焦点用；用户切去处理时自然由该会话的后续事件接管。

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
  关闭时端点仍 204 但丢弃事件——hooks 残留也无害）与 `connectors.zcode.followLatestUser`
  （§3.1 跟随模式，默认 false）。
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

## 8. hook stdin 载荷通道（Phase 10，2026-09-18 spike 实证 + 落地）

思考用时/编辑行数（统计泡泡 HUD）需要 hook 载荷。spike 方法：临时给已装
hook 的 cfg 加 `data-binary = "@-"` + `trace-ascii`（cfg 内容每次点火时读，
不需重启客户端），本会话触发一次 Edit 自观察。

### 8.1 stdin JSON 形状（实测）

同一对象上**双命名并存**——zcode 原生 camelCase + Claude Code 兼容
snake_case：`sessionId`/`session_id`、`toolName`/`tool_name`、
`toolInput`/`tool_input`、`toolResponse`/`tool_response`（PostToolUse，含
stdout/exitCode 等结果）、`timestamp`（ISO，zcode 自己的事件时间）、
`turnId`（回合关联，白捡）、`transcriptPath`、`cwd`、`hookEventName`。
PreToolUse 就带 `toolInput`（Edit 的 old/new_string、Write 的 content）——
**行数在写入开始时即可算**，post-tool 只当完成信号。读取顺序 snake 优先、
camel 兜底（`countEditLines` 同时服务将来的 Claude Code 连接器）。

### 8.2 传输与解析

- hook args：`--config <cfg> --data-binary @-`（stdin 原样 POST；不再
  `--data-urlencode session=`，session 从 JSON 取）。**需重装 hooks + 重启
  zcode 客户端生效**；旧格式安装继续工作（无载荷，只有状态事件）。
- 端点双格式：body 以 `{` 开头 → JSON（容忍尾部 `&session=`——过渡期混装时
  curl 会拼接）；否则旧 urlencoded 路径。上限 1MB（Write 可带整个文件）。
- **隐私不变量**：编辑内容在 HTTP 边界即归约为行数（`line-count.ts`），
  账本只存整数与 id，不落盘、不过 stats 路由。filePath 仅作显示元数据保留。

### 8.3 stats 账本（连接器无关）

`stats-ledger.ts`：连接器把原生事件翻译成两类规范化事实——状态转换
（`recordState`）+ 编辑事实（`recordEdit`），账本负责思考区间累加
（waiting 打断不计）、行数总计、seq 环形事件流（容量 256，HUD 增量拉取）
与焦点会话（显式 focus > 最近活跃）。**记账在 follow 门控之前**：后台会话
照常记账（与 watchdog 记账同语义）。Claude Code 连接器将来平移此层；
DSH 桥的 `tool/call` arguments 本就带载荷，后续可从桥侧喂同一账本。

### 8.4 新增端点与模块

- `GET /api/petween-desktop/stats?since=<seq>`（只读，无写栅栏）。
- `line-count.ts`（纯函数：LCS 行 diff + 补丁/多编辑解析 + 1M cell 兜底）、
  `stats-ledger.ts`、`stats-routes.ts`；渲染层 `companions/bubbles/`
  （BubbleHost/样式/动画注册表）+ `companions/stats-hud/`。

### 8.5 对话数据通道（第二批）

回复文本不经过 hooks（Stop stdin 无文本、临时 transcript 用后即删）：读 zcode 持久化的 （AI-SDK 形状，finishReason+text+turnId）。坑：单行内嵌完整请求上下文，长会话 >1MB/行（实测 10MB 文件）——固定尾窗必漏最后一行 stop；实现为 readline 流式前扫 +  子串预过滤，只有候选行才 JSON.parse。归约边界：markdown 剥离 + 160 字截断，零持久化， 按需读。全链路唯一内容级通道（用户拍板的隐私面例外，与 §8.3 的计数不变量并行不悖）。
