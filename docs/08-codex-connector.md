# 08 — OpenAI Codex 连接器规格（Phase 16）

> 定位与 docs/06/07 相同：写/改 `src/main/connectors/codex-*` 前先读完本文。架构不复述——引擎（hook-connector）、配置读改写（config-io）、路由脚手架（route-helpers）、dialogue 多源全部与 zcode/CC 共享，本文只写 Codex 的差异面。spike 基线：2026-09-20，本机 codex-cli **0.154.0** + openai/codex 仓库源码（codex-rs/hooks）+ 本机 live hooks.json（与 deja-vu hooks 共存形态实测）。

## 1. Codex 侧事实（spike 实证/源码核实）

1. **hooks 引擎是 CC 兼容的**（codex-rs 里引擎名就叫 `ClaudeHooksEngine`）：`~/.codex/hooks.json`，形状 `{ hooks: { <PascalCase事件>: [{ matcher?, hooks: [{ type:'command', command, timeout, statusMessage? }] }] } }`——本机 deja-vu 的 hooks 即此形态，实测共存。
2. **command 是单个字符串**（无 args 数组），Windows 下经 `cmd.exe /C <line>`（COMSPEC）执行——**cfg 路径必须在命令串里加双引号**（用户名可含空格）。stdin 管道喂事件 JSON。
3. **timeout 单位秒**；我们写 5。
4. **stdin 载荷**（schema.rs，snake_case）：公共 `session_id` / **`turn_id`** / `transcript_path`（可 null——`disable_response_storage` 下可能缺席）/ `cwd` / `hook_event_name` / `model` / `permission_mode`；工具事件加 `tool_name` / `tool_input`（+`tool_response`/`tool_use_id`）。**`turn_id` 是官方回合 id，直接作账本 turnId**（比 CC 的 prompt_id 推导还直接）。
5. **信任机制**：Codex 对每个 (event, matcher, group) 算哈希并与受信存储比对——**安装后 Codex 会请求一次信任确认**（`bypass_hook_trust` 托管策略存在但不归我们碰）。设置卡文案已注明。
6. **matcher 语义**：CC 族（纯字符集=精确/`|` 列表，含正则字符=不锚定 RegExp.test）。
7. 事件面 12 个：比 CC 多 `Interrupt`（用户打断）、`PreCompact`/`PostCompact`/`SubagentStart/Stop`；**无 `Notification`**。
8. `notify`（config.toml）是旧式单事件通知（本机 Pebrel 在用）——不采用，hooks.json 是正路。

## 2. 事件映射

| Codex 事件 | matcher | petween kind | 说明 |
|---|---|---|---|
| SessionStart | — | session-start | idle 基线 / focus 信号 |
| UserPromptSubmit | — | user-prompt-submit | thinking + turn/start |
| PreToolUse | `apply_patch\|write_file\|Edit\|Write\|MultiEdit\|NotebookEdit` | pre-tool-edit | 原生+CC 别名并集（matcher_aliases） |
| PreToolUse | `shell\|Bash\|local_shell\|shell_command\|exec_command` | pre-tool-command | |
| PreToolUse | 负向前瞻（上两者之并集的补） | pre-tool-other | 同 CC/zcode 的锚定观察项 |
| PostToolUse | — | post-tool | Codex 无 PostToolUseFailure |
| PermissionRequest | — | permission-request | 原生事件 |
| Stop | — | stop | 60s 衰减 |
| **Interrupt** | — | **session-start** | 用户打断=立即 idle；不注册则打断后猫卡工作脸到 30min 兜底 |
| SessionEnd | — | session-end | 即时 dispose（引擎 disposeKinds） |

编辑行数：`apply_patch` 载荷是 patch 文本（line-count 的 countsFromPatch 分支）+ CC 形状的 Edit/Write 兜底——两种都已覆盖。

## 3. 传输与端点

curl + cfg 同 zcode/CC（`userData/codex-hooks/<kind>.cfg` 每 boot 重写端口；`noproxy`/`connect-timeout 1`/`max-time 2`/`silent`）。端点 `POST /api/petween-desktop/connector/codex/event?e=<kind>`（1MB 帽/session 白名单/永远 204）+ status/install/uninstall。stdin 解析 `parseCodexHookBody`：`turn_id`→turnId、`transcript_path`（null 容忍）→transcriptPath、`tool_name`/`tool_input`。

## 4. 安装/卸载（~/.codex/hooks.json）

config-io 全套（精确归属=命令串含我们某个 cfg 路径、串行化、.petween-bak、非数组/非对象拒绝、损坏拒绝）；外来 hooks（deja-vu 等）与无关顶层键原样保留；卸载后全空删 hooks 键 + 清 bak。

## 5. 对话泡泡（rollout 直取）

rollout 文件 `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`，行形状 `{timestamp, ordinal, type, payload}`。**`event_msg` + `payload.type === 'task_complete'` 直接带 `turn_id` 和 `last_agent_message`**——对话源只需流式留最后一个非空非错的 task_complete（比 CC 的父链回溯还简单）。session→文件：注册表（载荷 `transcript_path`，校验必须位于 `~/.codex/sessions` 下——防伪造载荷把 /dialogue 变任意文件预言机）+ 递归后缀扫描兜底（文件名以 `-<sessionId>.jsonl` 结尾，深度 ≤4，结果缓存）。流式 + 64MB 总字节帽 + 4MB 行帽；只有含 `"task_complete"` 的行驻留。

## 6. 观察项 / 已知风险（真机验证清单）

1. **信任确认 UX**：安装后 Codex 的信任提示具体形态未实测（文档未展开）——预期一次性确认，若体验糟糕再评估。
2. **hooks.json 热加载未实证**（CC 是热加载，zcode 要重启）——安装后新会话生效是保守假设；若实测要重启 Codex，改设置卡文案。
3. **matcher 锚定**：负向前瞻同 docs/06 §7.1 / docs/07 §6.1 观察项（引擎 matcher_aliases 的别名表未逐个实测；并集 matcher 已尽量宽）。
4. **工具名漂移**：Codex 工具名随版本演进（shell/local_shell/exec_command……），matcher 并集覆盖当前已知集——漏网的落 pre-tool-other（猫仍工作脸，只有图标分类差异），无功能风险。
5. **disable_response_storage**：transcript_path 可能为 null——该会话无对话泡泡（状态/统计泡泡不受影响）。

## 7. 模块清单与测试

| 文件 | 职责 |
|---|---|
| `src/main/connectors/codex-connector.ts` | Codex profile（kinds/映射/Interrupt→idle） |
| `src/main/connectors/codex-hooks.ts` | cfg 渲染 + hooks.json 合并安装/卸载（命令串形态） |
| `src/main/connectors/codex-routes.ts` | 四端点 + Codex stdin 解析 |
| `src/main/connectors/codex-dialogue-source.ts` | task_complete 直取 + 注册表/扫描（§5） |
| `src/main/index.ts` | 接线镜像（含 quit dispose、dialogue sources 第三源） |
| `src/renderer/settings/main.tsx` | 设置卡第三实例（信任确认文案） |

测试：codex-hooks 10（命令串形状/三组 matcher/Interrupt 共 cfg/deja 共存/幂等/拒绝/串行/兄弟目录）、codex-connector 5（全词汇映射/session-end/watchdog 三时值/follow/stats turn_id）、codex-routes 7（stdin 解析含 null transcript/栅栏/405/500）、codex-dialogue-source 7（task_complete 提取/注册表校验/后缀扫描/字节帽）。
