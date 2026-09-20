# 07 — Claude Code 连接器规格（Phase 15）

> 定位与 docs/06（zcode 连接器）相同：本文件是 CC 连接器的规格级契约，写/改 `src/main/connectors/cc-*` 前先读完本文。架构不再复述——**引擎、安装基建、路由脚手架全部与 zcode 共享**（见 §1），本文只写 CC 的差异面。spike 基线：2026-09-20，本机 Claude Code **2.1.234** + 官方 hooks reference（code.claude.com/docs/en/hooks）。

## 1. 共享层（Phase 15 抽取）

| 模块 | 内容 | 此前的位置 |
|---|---|---|
| `connectors/hook-connector.ts` | 会话簿记、watchdog 级联（stop 60s→idle / permission 10min→idle / 30min 惰性 dispose）、follow 模式（焦点代理/退休/重放/v0.4.0 修复的切换吞事件）、stats 记账（follow 门控之前）、伪造 DSH 信封 | zcode-connector.ts 内联 |
| `connectors/config-io.ts` | 用户 JSON 配置的加固读改写：随机 tmp + 原子 rename、`.petween-bak` 单代备份、按路径键的串行化链、损坏文件拒绝改写 | zcode-hooks.ts 内联 |
| `connectors/route-helpers.ts` | sendJson、跨源写栅栏、限额 readBody、exact 注册 + 错误包裹 | zcode-routes.ts 内联 |

zcode-connector/zcode-hooks/zcode-routes 重构为这些模块的薄壳，**行为零变化**（37 个 zcode 连接器用例是引擎的行为契约）。Codex 连接器（Phase 16）将是第三个消费者。

## 2. CC 侧事实（spike 实证/文档核实）

1. **配置位置**：`~/.claude/settings.json` 顶层 `hooks` 键，形状 `事件名 → [{ matcher?, hooks: [{ type: 'command', command, args?, timeout? }] }]`——与 zcode 的 hooks 词汇同构（zcode 即仿 CC）。**无 `hooks.enabled` 开关**（存在即生效；全局开关是 `disableAllHooks`，我们不碰）。
2. **exec 形式**：`command`+`args` 数组直接 spawn 不过 shell（Windows 下 shell 形式走 Git Bash）——curl.exe 是真 exe，用 exec 形式正合适；本机用户已有的 Pebrel hooks 即此形态，实测共存。
3. **timeout 单位是秒**（zcode 是毫秒）：我们写 `timeout: 5`。SessionEnd 事件共享 1.5s 完成预算（可提到 60s）——回环 curl 毫秒级完成，不受影响。
4. **热加载**：CC 用文件监听器自动拾取 settings.json 的直接编辑——**安装/卸载即时生效，无需重启 CC**（与 zcode 的「重启客户端生效」相反，设置卡文案已区分）。
5. **stdin 载荷**（双命名沿用 zcode 的 snake 优先读法）：公共字段 `session_id`、`prompt_id`、`transcript_path`、`cwd`、`permission_mode`、`hook_event_name`；工具事件加 `tool_name`、`tool_input`、`tool_use_id`。**`prompt_id` 即回合 id**（每 prompt 一个）→ 直接作 turnId 喂账本。
6. **matcher 语义**：纯字符集（字母数字 `_` `-` 空格 `,` `|`）= 精确串/`|` 列表；含任何其他字符 = 不锚定 `RegExp.test`——与 zcode 同族（见 §6 观察项）。
7. **不用 http handler 类型**：CC 原生 `"type": "http"` 有 `allowedHttpHookUrls` 白名单约束且 URL 会写进用户 settings（每 boot 端口变化就要动用户文件）；curl + cfg 方案端口发现完全在我们自己的目录里。

## 3. 事件映射（CC 事件 → petween kind → 宠物视觉）

| CC 事件 | matcher | petween kind | 信封（fabricated） | 账本状态 |
|---|---|---|---|---|
| SessionStart | — | session-start | agent/status idle | idle |
| UserPromptSubmit | — | user-prompt-submit | turn/start + assistant/chunk(reasoning-delta) | thinking |
| PreToolUse | `Edit\|Write\|MultiEdit\|NotebookEdit` | pre-tool-edit | tool/call name=edit | working |
| PreToolUse | `Bash` | pre-tool-command | tool/call name=bash | working |
| PreToolUse | `^(?!(?:Edit\|Write\|MultiEdit\|NotebookEdit\|Bash)$)` | pre-tool-other | tool/call name=read | working |
| PostToolUse / PostToolUseFailure | — | post-tool | tool/result | thinking |
| PermissionRequest | — | permission-request | approval/asked | waiting |
| Notification | **不注册**（真机实证 2026-09-20） | — | — | — |
| Stop | — | stop | turn/end completed | success |
| SessionEnd | — | **session-end** | （无视觉——直接 dispose） | — |

要点：

- ~~**PermissionRequest 与 Notification 共用 `permission-request` kind**~~（真机推翻：回合成功后约一分钟 CC 发 Notification「waiting for your input」闲置提示 → 宠物从 success 脸翻成等待授权脸（ledger 事件序列坐实：`11:57:01 success → 11:58:01 waiting`，之间无任何用户操作）——已按 §6.2 预案摘除 Notification 注册，只留 PermissionRequest；闲置等待由 success 60s 衰减自然覆盖）。
- **session-end 是 CC 独有 kind**（zcode 没有 SessionEnd）：引擎在清定时器后立即 dispose（emitSessionDisposed + 账本行清除 + followTarget 摘除），**排在排惰性 dispose 定时器之前**（否则残留定时器会在死会话上二次 dispose——已修并有用例钉住）。30min 惰性 watchdog 仍保留，覆盖 CC 崩溃路径。
- Subagent/Task/Teammate 系事件不注册：子代理载荷带 `agent_id`，事件与主会话同 session_id，注册只会制造噪音。
- `prompt_id` 作 turnId：user-prompt-submit 开账本回合（recordTurnStart）、stop 的 state fact 携带（回合差值结算用）——与 zcode 的 turnId 语义一致。

## 4. 传输与端口发现

与 zcode 完全同构：`userData/cc-hooks/<kind>.cfg` 每 boot 用当前随机端口重写（`writeCcHookConfigs`），hook = `curl.exe --config <cfg> --data-binary @-`（stdin JSON 原样转发）。cfg 内容四防线不变：`connect-timeout 1` / `max-time 2` / `noproxy "*"` / `silent`。端点 `POST /api/petween-desktop/connector/cc/event?e=<kind>`，1MB body 上限、session id `[\w.-]{1,200}` 白名单、未知 kind 400、永远 204 快答。

CC stdin 解析（`parseCcHookBody`）：只收 JSON（无 legacy 世代）；`session_id`→sessionId、`prompt_id`/`promptId`→turnId、`tool_name`/`toolName`→toolName、`tool_input`/`toolInput`→toolInput；解析失败按无效 session 处理（400）。

## 5. 安装 / 卸载（~/.claude/settings.json）

`installCcHooks` / `uninstallCcHooks` / `ccHooksInstalled`，加固全量适用（config-io；卸载后清 .petween-bak、顶层 hooks 非对象拒绝——与 docs/08 §4 对齐）：

- **合并写**：`hooks` 之外的顶层键（`env` 含密钥、`model`、`permissions`…）与外来 hooks 组原样保留；每个我们管理的 CC 事件先滤掉旧自有组再追加。
- **归属判定 = 精确 cfg 路径**：hook 的 args 里出现恰好等于我们某个 cfg 文件路径的字符串才算自有——兄弟目录（`cc-hooks.bak/`）的用户拷贝、任何外来 curl 永不匹配。
- 非数组事件值拒绝改写（报错不装）；损坏 JSON 拒绝改写；`.petween-bak` 单代备份；随机 tmp + 原子 rename；按路径串行化。
- 卸载后 events 全空则整个 `hooks` 键删除（回到无 hooks 的原始形态）。

设置卡（连接分区）：`HookConnectorCard` 泛型组件双实例（zcode/CC），CC 实例的安装文案注明**无需重启**。

## 6. 观察项 / 已知风险（真机验证清单）

1. ~~**负向前瞻 matcher 的锚定语义**~~（✅ 2026-09-20 真机验收实证三类工具表情全对上，docs/05 Phase 15 清单）。
2. ~~**Notification 的触发面**~~（✅ 已实证并处理，见 §3 要点：回合后闲置提示污染 success 脸——摘除注册）。
3. **SessionEnd 的 1.5s 预算**：回环 curl 实测毫秒级，但极端情况下（本服务正忙）hook 可能被掐——30min watchdog 兜底，无正确性风险。
4. **stats 泡泡的回合口径**：CC 的 stop 一定带 `prompt_id`；若某事件缺失 turnId（版本差异），账本按无 turnId 容忍（回合差值退化为会话累计基线），泡泡照出只是精度略降。
5. ~~**对话泡泡（回复摘要）后置**~~（✅ 同日解绑批落地，见 §9）：CC 载荷带 `transcript_path`（`~/.claude/projects/<cwd-slug>/<session-id>.jsonl`）。

## 7. 模块清单

| 文件 | 职责 |
|---|---|
| `src/main/connectors/cc-connector.ts` | CC profile（kinds/映射/信封/session-end） |
| `src/main/connectors/cc-hooks.ts` | cfg 渲染/落盘 + settings.json 安装/卸载/查询 |
| `src/main/connectors/cc-routes.ts` | 四个 HTTP 端点（event/status/install/uninstall） |
| `src/main/index.ts` | 生命周期接线：boot 写 cfg、启停随设置（镜像 zcode 块） |
| `src/renderer/settings/main.tsx` | 连接分区 Claude Code 卡片（HookConnectorCard） |
| `src/main/connectors/cc-dialogue-source.ts` | 回复文本源：transcript 父链回溯 + 注册表/扫描（§9） |
| `src/main/connectors/dialogue-text.ts` | 回复预览归约（剥 markdown/截断）——各源共享 |

Host 白名单（v0.4.0）对 CC 端点同样生效——routes-host dispatcher 一处覆盖。

## 8. 测试

- `tests/main/cc-hooks.test.ts`：cfg 渲染/端口重写、events 形状（exec 形式/秒 timeout/matcher 三组/共用 cfg）、合并安装（保留 env 密钥与 Pebrel 式外来 hooks）、幂等重装、损坏/非数组拒绝、.bak、并发串行化、精确归属（兄弟目录）。
- `tests/main/cc-connector.test.ts`：事件映射（含 session-end 即时 dispose 且定时器随死）、watchdog 三时值、follow 门控+切换（v0.4.0 语义）、stats（prompt_id→turnId、Edit 形状计数、session-end 清行）。
- `tests/main/cc-routes.test.ts`：parseCcHookBody（CC stdin 形状/坏输入）、sink 校验（未知 kind/坏 session/禁用时丢弃/跨源 403/非 POST 405）、status/install/uninstall 真实 HTTP。

## 9. 对话泡泡解绑（2026-09-20 同日追加，v0.5.1）

对话泡泡原本绑定 zcode（dialogue-source 写死读 rollout 目录）。解绑批落地多源架构，CC 回复泡泡即点亮：

- **transcript 形状（spike 实证，本机真实文件）**：混合行类型中只有 `user`/`assistant` 有用；**每条 `user` 行带 `promptId`**（= hook 载荷的 prompt_id = 账本 turnId），assistant 行不带——但 **parentUuid 父链 100% 可回溯**到所属 user 行（实测 6/6），回合匹配是精确的；回复文本 = 最后一条主链（非 `isSidechain`）带 text 块的 assistant 消息（多个 text 块拼接）——与 zcode「最后一条 stop 消息」同语义；`isApiErrorMessage` 条目跳过。
- **session→源 解析**：`cc-dialogue-source` 持注册表，`index.ts` 在每个 hook 事件上用载荷的 `transcript_path` 喂它（`HookPayload.transcriptPath` 通用字段，zcode 不设）；应用中途重启（注册表空）时一次性扫描 `~/.claude/projects/*/<sessionId>.jsonl` 兜底（结果缓存，正负皆然）。
- **路由多源化**：`GET /dialogue?session=` 的 deps 从单 `source` 改为 `sources[]`，顺序探测首个非空（zcode `sess_*` 与 CC UUID 实际不冲突，顺序不负载）；HUD 零改动。
- **归约共享**：剥 markdown + 160 字截断提取为 `dialogue-text.ts`，两源共用——隐私不变量不变（内容只在源处归约、零持久化、no-store）。流式纪律与字节帽（64MB 总帽/4MB 行帽，v0.6.0 评审改流式）与 codex 源对齐；注册表仅收 `~/.claude/projects` 下路径（防伪造载荷把 /dialogue 变任意文件读预言机）。
- 测试：`cc-dialogue-source.test.ts`（父链/sidechain/API 错误/最后带文本者/注册表/扫描兜底/非法 id）+ `dialogue-routes.test.ts` 多源探测改造。
