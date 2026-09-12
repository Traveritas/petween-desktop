# DSH 状态桥实现规格

> 版本基线：`@deepseek-ai/dsh@0.1.0-rc.7` CLI（嵌套依赖 rc.8）；petween 的 event-normalizer 注释声明按 rc.7 验证——两者在这些契约上无差异。调研日期 2026-09-12。
> 本文档由子智能体对 DSH 官方包源码（`D:\Nodejs\node_global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`）逐文件核实产出，规格级细节，实现桥时**不需要再读 DSH 源码**。

## 0. 桥的职责一句话

作为外部进程连本地 DSH web 服务的两条 WebSocket 下行流，把帧转换成 petween 的 `StateChannelHost` 事件（4 个 `on()` 回调），复用 `normalizeSessionEvent` → `attachStateChannel` → SSE 的既有链路，供 overlay 窗口的 `EventSource` 消费。

```
DSH (127.0.0.1:3080)                     Electron main
  ws /api/events.mux   ──┐               DshBridge
  ws /api/events.host  ──┴─► 帧解包/转换 ─► StateChannelHost.on(...)
                                          │ (attachStateChannel 内部)
                                          ▼ normalize → publish → SSE
                                overlay 渲染进程 EventSource（零改动）
```

## 1. petween 侧消费契约（RawSessionEvent 与 StateChannelHost）

### 1.1 输入类型 `RawSessionEvent`（`vendor/petween/src/integration/dsh/event-normalizer.ts:36-40`）

```ts
interface RawSessionEvent { type: string; time: number; data: unknown }
```

结构性宽类型（非严格校验）：`seq` 不在类型里但允许存在。桥透传 mux 帧里的整个 `event` 对象即可（含 `seq`/`sourceEventSeqs`/`surfaceOp`/`ignorable`）。`time` = unix epoch ms。

### 1.2 `normalizeSessionEvent` 消费的 type 全集（其余全部返回 null 忽略）

签名：`normalizeSessionEvent(sessionId: string, event: RawSessionEvent): NormalizedAgentEvent | null`（event-normalizer.ts:82）

| event.type | 读取的 data 字段 | 产出 |
|---|---|---|
| `turn/start` | `{turn}`（忽略） | `{type:'turn-start', sessionId, ts}` |
| `assistant/chunk` | `data.chunk.type` | `chunk.type === 'reasoning-delta'` → `thinking`；其他 chunk（text-delta 等）→ null |
| `tool/call` | `data.name` | `'ask_user_question'` → `waiting`；否则 `tool-start` + toolKind：`edit`(edit/write/str_replace_editor)、`command`(bash/pwsh)、`other` |
| `tool/result` | 忽略 | `tool-end` |
| `approval/asked` | 忽略 | `waiting` |
| `approval/decided` | 忽略 | `thinking` |
| `turn/end` | `data.reason.kind` | completed→`success`；error、max-tokens→`error`；aborted、interrupted→`idle`；blocked→`waiting`；**未知 kind→null** |

另两个独立函数：
- `normalizeAgentStatus(sessionId, status)`：仅 `status === 'idle'` → `{type:'idle', ts: Date.now()}`（本地时钟）；`'running'` → null。
- `normalizeAgentError(sessionId)`：→ `{type:'error', ts: Date.now()}`。

### 1.3 产出 `NormalizedAgentEvent`（`state-protocol.ts:15-23`）

```
| { type:'idle'|'turn-start'|'thinking'|'tool-end'|'waiting'|'success'|'error'; sessionId?: string; ts:number }
| { type:'tool-start'; toolKind:'edit'|'command'|'other'; sessionId?: string; ts:number }
```

StateFrame：`{kind:'snapshot', events:[]}` | `{kind:'event', event}`；端点 `EVENTS_PATH='/api/petween/events'`、`STATE_PATH='/api/petween/state'`。

### 1.4 桥需要提供的 `StateChannelHost`（`state-channel.ts:45-53`）

```ts
interface StateChannelHost {
  on('session/event', (session:{id:string}, event: RawSessionEvent): void): ()=>void
  on('session/disposed', (session:{id:string}): void): ()=>void
  on('agent/status', (payload:{agent:{id:string}; status:string}): void): ()=>void
  on('agent/error', (payload:{agent:{id:string}}): void): ()=>void
  webServer: { register(route: {kind:'exact'; path:string; handler:(req,res)=>void}): ()=>void }
}
```

`attachStateChannel(host)` 的驱动时序：`on()` 返回退订函数（寄存即订阅）；每事件先 normalize，非 null 才 publish；publish 更新 `lastBySession` 并向匹配的 SSE 客户端广播；心跳注释 `: petween\n\n` 每 25s；`session/disposed` 删除该 session 的记忆；`webServer.register` 被调用 2 次（EVENTS_PATH/STATE_PATH exact 路由）——桥给一个接到自有 HTTP server 的假实现即可。

## 2. WS 下行帧精确格式

### 2.1 端点与信封

- URL：`ws://127.0.0.1:3080/api/events.mux`、`ws://127.0.0.1:3080/api/events.host`。
- **纯下行**：客户端发任何数据帧都会被 `close(1008, 'downlink only')`。WS 协议层 ping/pong 控制帧不触发 message，安全。
- **帧是 JSON 文本**（浏览器端明示拒绝二进制帧）；**无子协议**（不要传 `Sec-WebSocket-Protocol`）。
- 每帧外层信封（serverRequestSchema）：

```json
{ "type": "server-request", "rpcId": "<uuid>", "method": "<帧 payload.type 原样>", "payload": { <完整帧，含 type 字段> } }
```

### 2.2 mux 流帧（MuxFrame）

| 帧类型 | 字段 | 桥的动作 |
|---|---|---|
| `session/event` | `{type, sessionId, event: SessionEvent, view?}` | **核心输入**。解包后把 `event` 原样喂 `normalizeSessionEvent(sessionId, event)`；`view` 忽略 |
| `session/subscribed` | `{type, sessionId, lastSeq}` | 记入当前挂载 session 集（重连对照用，见 §3.6） |
| `approval/*`、`question/*`、`session/queue`、`session/jobs`、`session/projection` | — | **全部忽略**。approval 同时以持久事件 `approval/asked|decided` 走 session/event 路径，只消费后者即可复刻 cordis 行为 |
| `stream/error` | `{error}` | 视作流终止（对齐官方客户端），触发重连 |

**`session/event.event` 与 cordis `session/event` 载荷逐字段一致**（seq/time/type/data + 可选 sourceEventSeqs/surfaceOp/ignorable）——mux 实现就是把 cordis 事件的 event 原样放入。唯一差异：多一个可选宿主计算字段 `view`。

SessionEvent 各 type 的 data 形状要点：`turn/start {turn}`、`turn/end {turn, reason}`、`assistant/chunk {turn, step, chunk:StreamChunk}`、`tool/call {turn, step, callId, name, arguments:string}`、`tool/result {turn, step, message, error?, meta?}`。StreamChunk 判别值：`block-start|text-delta|reasoning-delta|tool-call-delta|block-end|usage|finish`。TurnEndReason.kind：`completed|aborted|blocked|error|max-tokens|interrupted`。

### 2.3 host 流帧（HostFrame）

| 帧类型 | 字段 | 桥的动作 |
|---|---|---|
| `host/session-removed` | `{sessionId}` | **合成 `session/disposed`**（mux 上没有此信号，见 §7 转换点 2） |
| `host/session-status` | `{sessionId, running: boolean}` | **合成 `agent/status`**：`running===false` → `normalizeAgentStatus(sessionId,'idle')`；`true` → `normalizeAgentStatus(sessionId,'running')`（返回 null 等价丢弃，保留调用形态防未来加状态） |
| `host/agent-error` | `{sessionId, message}` | → `normalizeAgentError(sessionId)`（丢 message） |
| `host/session-added`、`host/workspace-*`、`host/remote-event` 等 | — | 忽略 |

**host 流开帧不推任何基线**——session 存量集合只能从 mux 的 subscribed 帧或 `POST /api/session.list` 获得。

### 2.4 mux 开帧时序

连接建立后服务端**立即**按序推送基线：① 每个已挂载 session 一帧 `session/subscribed {sessionId, lastSeq: 当前seq-1}`；② 未决 question 重放；③ 未决 approval 重放；④ 排队消息；⑤ 后台任务。之后进入推送模式。「挂载」= session 当前有内存对象；**DSH 重启后不自动重挂历史 session**。注意 mux 对 `session/disposed` 不发任何帧（只清内部表）。

## 3. 连接生命周期

### 3.1 断线续传：`since` 未实现，别用

`EventsApi.mux` 的 `since` 参数文档明说 "unimplemented in v1 (ignored if passed); reconnection = reopen the stream + refetch history"。**桥不要试图用 since 做增量续传。**

状态桥其实不需要逐事件续传——normalize 后的事件是幂等语义（每 session 只留最新一条）。重连后只需：① 重新收 subscribed 基线；② 可选地对关注 session `POST /api/session.history` 拉尾页重放恢复「当前状态」；③ 未收到的旧事件直接放弃。

### 3.2 `POST /api/session.history`

请求体（外层信封见 §4.2）payload：

```json
{ "sessionId": "<id>", "beforeSeq": 123, "maxMessages": 50 }
```

是 **`maxMessages` 不是 `limit`**；`beforeSeq` 省略 = 从尾部；`maxMessages` 省略默认 50。响应 value：`{events: [{event, view?}], hasMore, projections?}`。

### 3.3 心跳：服务端零心跳

DSH 的 webserver 与 WS 下行链**没有任何 ping/keepalive/idle timeout**。死链只能靠客户端检测：桥用 `ws` 库定期 `ws.ping()`（20-30s 间隔、2 次无 pong 判死）——控制帧不违反 downlink-only，服务端 ws 库默认自动 pong。

### 3.4 重连退避（抄官方 ConnectionController 参数）

`backoffBaseMs: 500`、`factor: 2`、`maxMs: 10_000`，`delay = cap/2 + random()*cap/2`（带抖动，首次 ~250-500ms，10s 封顶）。每代并发开 mux+host 两流 + `host.describe()`；`Promise.race([两流 open, sleep(3s)])` 就绪握手；成功 → attempt=0，任一流终止 → 重连。`stream/error` 帧视作流终止。

### 3.5 DSH 重启处理

session id 由进程内计数器铸造（`session-${++counter}`），重启后可复用但指代不同运行。重连成功后收到的新 subscribed 集 = 真理：**凡在旧记忆、不在新 subscribed 集且未收到 host/session-removed 的 session，视为已消失**，从记忆清除（等价 session/disposed，聚合端自然回 idle）。不要跨重启续传 seq。

## 4. 访问控制（isTrustedApiRequest）

判定顺序：① 无 Host 头拒；② Host 非 loopback（`localhost`/`[::1]`/127.x.x.x）且不在 trustedHosts 拒；③ `Sec-Fetch-Site: cross-site` 拒；④ **无 Origin 放行**，有则须与 Host 同 host:port。

Node `ws` 客户端默认只发 Host/Upgrade/Sec-WebSocket-Key 等标准头——**无 Origin、无 Sec-Fetch-\***——直接通过。唯一翻车写法：给 ws 传 `origin` 选项且与 Host 不同源，或连非 loopback 域名。**URL host 字面量用 `127.0.0.1` 或 `localhost`，别带会改写 Host 的代理。**

`PRIVILEGED_METHODS`（settings/credentials 等）额外钉死 loopback——桥只调 `session.history`/`session.list`/`host.describe`，不涉及；`host.describe` 不在特权集，可作探活（校验返回含 `version`）。HTTP POST 的 Content-Type 必须是 `application/json`（否则 415）。

### 4.2 HTTP RPC 信封（桥调 history/list/describe 用）

请求 `POST http://127.0.0.1:3080/api/<method>`，body：

```json
{ "type": "client-request", "rpcId": "<uuid>", "method": "<method>", "payload": {…} }
```

响应：`{ "type": "server-response", "rpcId": "<回显>", "result": {ok:true, value} | {ok:false, error:{code,message,details}} }`。`method` 必须与 URL 端点一致。官方默认超时 30s。`host.describe` value：`{version, cwd, provider?, model?, attachedSessions, home, canOpenPath}`。

**别对 events 路径发 GET**（web 部署返回 426 Upgrade Required；apiproxy 的 SSE 回退只在无 client-connection 的组合可用）。

## 5. 端口发现

默认 3080（只能被 CLI flag `--port <N>` 改，`0` = OS 随机；`~/.dsh/settings.yaml` 改不了 web 端口；`~/.dsh/profiles/web/` 下**没有**可读的端口运行时文件）。DSH 给 agent 子进程注入 `DSH_WEB_URL` 环境变量，但 Electron 桥读不到。

发现策略（推荐顺序）：① 用户设置里的显式端口；② 默认 3080 直连探活；③ 可选兜底：WMI 枚举本机 node 进程命令行找 `--profile web --port (\d+)`，或小范围扫端口 + `POST /api/host.describe` 验证（返回含 version 即 DSH）。`--port 0` 情形只有进程枚举能发现。

## 6. DSH 不在时的降级

探活失败（连接拒绝 / describe 超时）→ 桥进入退避重连循环，不产出任何事件 → 渲染端保持既有状态（初始 idle）。桌宠退化为纯装饰模式。UI 可在托盘菜单显示「DSH 未连接」。断链期间渲染端可用 petween 已有的 `/state` 2s 轮询回退思路。

## 7. 「契约不一致、桥必须做转换」清单（实现时逐条对照）

1. `agent/status` 降级为布尔：cordis `{agent:{id}, status:'idle'|'running'}` → WS `host/session-status {sessionId, running:boolean}`。转换见 §2.3。
2. `session/disposed` 在 mux 上不存在：**必须同时开 `/api/events.host`**，`host/session-removed` 合成为 `session/disposed`（state-channel 靠它清理 lastBySession）。
3. `agent/error` 载荷变形：`{agent:{id}, error}` → `{sessionId, message}`；丢 message。
4. `session/event` 帧多出 `view` 与外层信封：解包 `serverRequest.payload` 取 `{sessionId, event}`，event 原样（含 seq）喂 normalize；view 忽略。
5. 开流即洪泛：只消费 session/event 路径；approval/question/queue/jobs/projection 控制帧全忽略。
6. 无增量续传：重连 = 重开两条流 + subscribed 集对照清差集 +（可选）history 尾页重放。
7. 时间戳来源混用：normalizeSessionEvent 用 `event.time`（DSH 时钟），AgentStatus/AgentError 用 `Date.now()`（本机）——单机部署无实际影响，知道即可。
8. HTTP 与 WS 混合：上行走 POST + client-request 信封 + `Content-Type: application/json`；下行只有 WS。
9. petween SSE 端点是桥自己的输出面：`attachStateChannel` 的 `webServer.register` 接到 local-server（渲染窗口 EventSource 连 `http://127.0.0.1:<port>/api/petween/events`），StateFrame/25s 心跳语义不变，state-adapter.ts 全部客户端逻辑白拿。

## 8. 关键文件索引（需要核对契约时再读）

- petween 契约：`vendor/petween/src/integration/dsh/{event-normalizer,state-protocol,state-adapter}.ts`、`vendor/petween/src/host/state-channel.ts`
- DSH 服务端：`dsh-client-connection/lib/index.js`（路由/信任栅栏/WS 泵）、`dsh-host-apiproxy/lib/index.js`（mux/host 实现、history、RPC 信封）、`dsh-host-apiproxy/lib/types/api/events.d.ts`（帧联合类型）、`dsh-session/lib/types/types.d.ts`（SessionEvent/TurnEndReason）
- DSH 客户端参考（官方用法）：`dsh-client-connection/lib/client.js`（ConnectionController 退避）、`dsh-client-runtime/lib/client.js`（resync/gap/lastSeq）
- 本机 DSH 安装位置：`D:\Nodejs\node_global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
