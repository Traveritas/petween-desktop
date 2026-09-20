# 08 — OpenAI Codex 连接器规格（Phase 16）

> 定位与 docs/06/07 相同：写/改 `src/main/connectors/codex-*` 前先读完本文。架构不复述——引擎（hook-connector）、配置读改写（config-io）、路由脚手架（route-helpers）、dialogue 多源全部与 zcode/CC 共享，本文只写 Codex 的差异面。spike 基线：2026-09-20，本机 codex-cli **0.154.0** + openai/codex 仓库源码（codex-rs/hooks）+ 本机 live hooks.json（与 deja-vu hooks 共存形态实测）。

## 1. Codex 侧事实（spike 实证/源码核实）

1. **hooks 引擎是 CC 兼容的**（codex-rs 里引擎名就叫 `ClaudeHooksEngine`）：`~/.codex/hooks.json`，形状 `{ hooks: { <PascalCase事件>: [{ matcher?, hooks: [{ type:'command', command, timeout, statusMessage? }] }] } }`——本机 deja-vu 的 hooks 即此形态，实测共存。
2. **command 是单个字符串**（无 args 数组），Windows 下经 `cmd.exe /C <line>`（COMSPEC）执行——**引号取舍见 §3 v0.6.4 取证**（首个 token 带引号即被 cmd 引号剥离劈坏；最终形态全无引号，空格路径是已记录取舍）。stdin 管道喂事件 JSON。
3. **timeout 单位秒**；我们写 5。
4. **stdin 载荷**（schema.rs，snake_case）：公共 `session_id` / **`turn_id`** / `transcript_path`（可 null——`disable_response_storage` 下可能缺席）/ `cwd` / `hook_event_name` / `model` / `permission_mode`；工具事件加 `tool_name` / `tool_input`（+`tool_response`/`tool_use_id`）。**`turn_id` 是官方回合 id，直接作账本 turnId**（比 CC 的 prompt_id 推导还直接）。
5. **信任机制**：Codex 对每个 (event, matcher, group) 算哈希并与受信存储比对——**安装后 Codex 会请求一次信任确认**（`bypass_hook_trust` 托管策略存在但不归我们碰）。设置卡文案已注明。
6. **matcher 语义（真机修正 2026-09-20）**：Codex 用 **Rust regex crate** 编译 matcher——**不支持 look-around**，CC 家族的负向前瞻「其他工具」模式直接被拒（启动警告 `invalid matcher`，该组被丢弃）。因此我们**不注册任何 PreToolUse matcher**：单个裸组（match-all）全量上报，**分类在路由边界按载荷 `tool_name` 重归类**（`classifyCodexToolKind`，工具名并集是 TS 单一事实源，免疫 matcher 语义漂移）。另：SessionEnd/Interrupt 事件超时被 Codex 钳到 3s——直接写 3 免启动警告。
7. 事件面 12 个：比 CC 多 `Interrupt`（用户打断）、`PreCompact`/`PostCompact`/`SubagentStart/Stop`；**无 `Notification`**。
8. `notify`（config.toml）是旧式单事件通知（本机 Pebrel 在用）——不采用，hooks.json 是正路。

## 2. 事件映射

| Codex 事件 | 注册形态 | petween kind | 说明 |
|---|---|---|---|
| SessionStart | — | session-start | idle 基线 / focus 信号 |
| UserPromptSubmit | — | user-prompt-submit | thinking + turn/start |
| PreToolUse | **单个裸组（无 matcher）** | pre-tool-other（路由按 `tool_name` 重归类为 edit/command/other） | Rust regex 无前瞻，分类收归我方（§1.6） |
| PostToolUse | — | post-tool | Codex 无 PostToolUseFailure |
| PermissionRequest | — | permission-request | 原生事件 |
| Stop | — | stop | 60s 衰减 |
| **Interrupt** | timeout 3（钳位） | **session-start** | 用户打断=立即 idle；不注册则打断后猫卡工作脸到 30min 兜底 |
| SessionEnd | timeout 3（钳位） | session-end | 即时 dispose（引擎 disposeKinds） |

编辑行数：`apply_patch` 载荷是 patch 文本（line-count 的 countsFromPatch 分支）+ CC 形状的 Edit/Write 兜底——两种都已覆盖。

## 3. 传输与端点（node sink，v0.6.4 重做——curl 在 Codex hook 执行器里读 stdin 必死）

**取证链（2026-09-20 真机，借道 Codex 信任哈希自铸逐条实弹）**：Codex 的 Windows hook 执行器（COMSPEC→cmd.exe，raw_arg 外层引号，env 重放+清洗）下——stdin 单独可读（findstr ✓）、网络单独可用（curl 不读 stdin ✓）、**curl 读 stdin + 网络必挂**（`--data-binary @-`/`-d @-`，任意引号/包装形态，exit 1 空 stderr）；**node.exe 读 stdin + fetch 完全正常且送达**。另两个坑：命令串**首个 token 带引号**会被 cmd 的 /C 引号剥离劈坏（「命令语法不正确」）；正斜杠程序路径被 cmd 当开关。最终形态（deja-vu 同款、双 shell 尽量安全）：**`<node.exe 反斜杠> <cfgDir>/sink.js <kind>`——全无引号**。

- **sink.js**（`userData/codex-hooks/`，随每 boot 的 cfg 重写一同落盘）：读 stdin JSON → 从本 kind 的 cfg 读端口 → fetch POST → 出口 0（1.8s 自杀兜底）。cfg 文件仍是端口发现载体（每 boot 重写随机端口；dev 17777）。
- **node 定位**：安装时 `findNodePath(process.env.PATH)` 解析系统 node.exe 绝对路径写入命令；缺失则安装报错（设置卡显示「需要系统 Node.js」）。已知取舍：两路径含空格时无引号形态会断（cmd 引号剥离 vs bash 反斜杠吞噬的两难，本机无空格、文档记录）。
- 端点 `POST /api/petween-desktop/connector/codex/event?e=<kind>`（1MB 帽/session 白名单/永远 204）+ status/install/uninstall。stdin 解析 `parseCodexHookBody`：`turn_id`→turnId、`transcript_path`（null 容忍）→transcriptPath、`tool_name`/`tool_input`。
- **端到端验证（exec 模式）**：9 hooks Completed / 0 Failed，事件序列 idle→thinking→working→thinking→success→turn-summary 全送达，工具任务真实创建文件。

### 3.1 信任哈希排障手册

Codex 对每个 (event, matcher, group) 以 `sha256(规范 JSON)` 记信任（config.toml `[hooks.state.'<file>:<snake事件>:<组>:<handler>']`），identity = `{event_name, [matcher], hooks:[{type:'command', command, timeout, async:false}]}`（键排序、null 剔除、`sha256:` 前缀）。修改命令→Modified→静默跳过；交互模式弹信任确认，exec 模式直接不跑（排障时可在 config.toml 预铸哈希跳过确认——本次取证即此法）。算法以 0.154 实证；上游 identity 序列化仍在演进，升级 Codex 后预铸前需重新取证。

## 4. 安装/卸载（~/.codex/hooks.json）

config-io 全套（精确归属=命令串含 sink.js/某 cfg/legacy cfg 路径、串行化、.petween-bak、非数组/非对象拒绝、损坏拒绝）；外来 hooks（deja-vu 等）与无关顶层键原样保留；卸载后全空删 hooks 键 + 清 bak。归属集含 legacy cfg 名单（pre-v0.6.2 三组 matcher 形态引用 pre-tool-edit/command.cfg——不进名单则重装永远清不掉，真机 4 组堆积实证）。

## 5. 对话泡泡（rollout 直取）

rollout 文件 `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`，行形状 `{timestamp, ordinal, type, payload}`。**`event_msg` + `payload.type === 'task_complete'` 直接带 `turn_id` 和 `last_agent_message`**——对话源只需流式留最后一个非空非错的 task_complete（比 CC 的父链回溯还简单）。session→文件：注册表（载荷 `transcript_path`，校验必须位于 `~/.codex/sessions` 下——防伪造载荷把 /dialogue 变任意文件预言机）+ 递归后缀扫描兜底（文件名以 `-<sessionId>.jsonl` 结尾，深度 ≤4，结果缓存）。流式 + 64MB 总字节帽 + 4MB 行帽；只有含 `"task_complete"` 的行驻留。

## 6. 观察项 / 已知风险（真机验证清单）

1. **信任确认 UX**：安装后 Codex 的信任提示具体形态未实测（文档未展开）——预期一次性确认，若体验糟糕再评估。
2. **hooks.json 热加载未实证**（CC 是热加载，zcode 要重启）——安装后新会话生效是保守假设；若实测要重启 Codex，改设置卡文案。
3. ~~**matcher 锚定**~~（✅ 真机推翻：Rust regex 无 look-around，前瞻 matcher 直接被拒——已改为路由侧 `tool_name` 分类，见 §1.6/§2）。
4. **工具名漂移**：路由分类的并集覆盖当前已知集——漏网的落 pre-tool-other（猫仍工作脸，只有图标分类差异），无功能风险；本机 deja-vu 的 hooks 用反斜杠路径经 bash 执行会 `command not found`（其自身问题，非我们引入——合并写保留其条目原样）。
5. **disable_response_storage**：transcript_path 可能为 null——该会话无对话泡泡（状态/统计泡泡不受影响）。
6. **exec 模式 Stop hook 竞态**：exec 模式下 Stop 事件 hook 对任何命令失败（deja-vu 二进制同败；Codex 回合收尾拆机竞态，Codex 侧问题，间歇性——同日 exec 亦有全序列成功送达案例）；交互模式（真实目标）不受影响。

## 7. 模块清单与测试

| 文件 | 职责 |
|---|---|
| `src/main/connectors/codex-connector.ts` | Codex profile（kinds/映射/Interrupt→idle） |
| `src/main/connectors/codex-hooks.ts` | cfg 渲染 + hooks.json 合并安装/卸载（命令串形态） |
| `src/main/connectors/codex-routes.ts` | 四端点 + Codex stdin 解析 |
| `src/main/connectors/codex-dialogue-source.ts` | task_complete 直取 + 注册表/扫描（§5） |
| `src/main/index.ts` | 接线镜像（含 quit dispose、dialogue sources 第三源） |
| `src/renderer/settings/main.tsx` | 设置卡第三实例（信任确认文案） |

测试：codex-hooks 13（cfg+sink 落盘/node sink 命令形态/findNodePath/事件面含 Interrupt 共 kind 与钳位 3/deja 共存/幂等+陈旧组清理/拒绝/串行/兄弟目录）、codex-connector 5（全词汇映射/session-end/watchdog 三时值/follow/stats turn_id）、codex-routes 8（stdin 解析含 null transcript/路由重归类/栅栏/405/500）、codex-dialogue-source 7（task_complete 提取/注册表校验/后缀扫描/字节帽）、codex-sink-e2e 3（sink.js 执行级：真路由表送达/服务器消失 exit 0/cfg 缺失 fail-closed）。
