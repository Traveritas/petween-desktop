# Petween 桌面版可行性评估（总报告）

> 基线日期：2026-09-12。petween 锁定版本：b0763e1（pluginConfigs P3）。DSH 版本：0.1.0-rc.7（嵌套 rc.8）。
> 本文是六轮子智能体调研的结论汇总；实现级细节见 02~04 号文档，执行清单见 05 号文档。

## 1. 结论

**难度评级：中低。桌面版 = 「零改动 petween + 新写 Electron 壳 + 新写 DSH 状态桥」。**

- petween 的 host 半（~4900 行）约 **90-95%** 是 DSH 无关纯逻辑；client 半（~11500 行）约 **90-95%** 可原样跑在普通浏览器窗口。
- MVP「**零改动 petween、纯装配级复用**」成立，且有仓库内先例背书：`tests/host/routes.test.ts`、`tests/host/plugin-entry.test.ts` 本质就是「无 DSH 宿主装配 petween」的可运行样例（fake webServer + node:http 派发）。
- 原以为的最大缺口「脱离 DSH 拿不到 agent 状态」**已被证伪**：DSH web 服务对外暴露 WebSocket 事件流（`/api/events.mux` + `/api/events.host`），DSH 官方网页前端就是这条通道的普通消费者——外部进程连它和官方用法同构，无鉴权（仅要求 loopback Host 头）。

工作量估算：MVP 1~2 周；完整版（托盘/自启/安装包/自动更新/physics 移植）再 +2~4 周。

## 2. 为什么这么容易：petween 的耦合面盘点

### 2.1 Host 半（子智能体核实，按文件逐项）

| 耦合点 | 位置 | 性质 | 迁移动作 |
|---|---|---|---|
| Cordis 插件接线 | `src/index.ts`（137 行） | 唯一真正绑死的文件，自述 "Wiring only" | 重写装配入口（deps 对象可照抄） |
| 路由注册 | `routes.ts` / `state-channel.ts` / `editor-page.ts` 的 `webServer.register` | handler 已是**原生 Node** `(IncomingMessage, ServerResponse)`；`RoutesHost` 是结构化最小接口 | 自写 ~30-50 行 exact/prefix 分发器（`routes.test.ts:80-120` 有现成参考实现） |
| SSE | `state-channel.ts` | 纯原生 writeHead/write/close | 零改动 |
| 存储路径 | 6 处 `dshHomePath` 默认值 | 全部「默认值函数 + options 可注入」模式 | 显式传 appData 路径 |
| 跨进程文件锁 | `storage.ts:34` 的 `withFileLock`（dsh-atomic-write） | 唯一运行时函数级依赖，纯 node:fs 实现 | 桌面壳 devDeps 直接装该包 |
| Agent 状态来源 | `state-channel.ts:172-193` 订阅 4 个 cordis 事件 | **唯一结构性缺口** | 新写 DshBridge（见 03 号文档） |

### 2.2 Client 半

- `client/index.ts`（59 行）是唯一真正 DSH 绑定（slots/sessions 注入）；不 import 它即可绕开。
- **编辑器已经是独立页面**：`lib/editor.js` 自包含 IIFE（React 内联），host 在 `/petween-editor/` 伺服，塞进设置窗口零代码复用（`registerEditorPage` 的 `loadBundle` 注入点已预留）。
- **Preview 已证明渲染栈脱离 DSH 可跑**（PetRenderer/PetStage/状态机/Timeline 引擎全家）。
- CSS 主题 token 全带硬编码 fallback；overlay 的 `position:fixed` + `pointer-events` 机制与透明 BrowserWindow 天然契合。
- 状态源有 `createStateSource` 注入缝；HTTP 全是根相对路径——同源伺服则零改动。

### 2.3 运行时依赖面

petween `package.json` **没有 runtime dependencies**（`@deepseek-ai/*` 全在 devDeps，DSH 场景靠 profile 树解析）。deep import `src/` 时实际需要的值依赖只有：`@deepseek-ai/dsh-home-paths`（仅默认路径兜底）、`@deepseek-ai/dsh-atomic-write`（withFileLock）、`fflate`（zip）+ 类型包 `@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-session` + `react`/`react-dom`。桌面壳自己声明即可。

## 3. Agent 状态来源：DSH 对外 API（关键事实）

外部进程（不作为 DSH 插件）可以拿到完整会话状态：

- `ws://127.0.0.1:3080/api/events.mux`——全量 `session/event` 流（连接即自动订阅所有已挂载会话，含 assistant/chunk、tool/call、turn/end 等）；
- `ws://127.0.0.1:3080/api/events.host`——`host/session-removed`（对应 cordis `session/disposed`，mux 流上**没有**此信号，必须双流同开）+ `host/session-status(running)` + `host/agent-error`；
- 辅助 HTTP：`POST /api/session.list`、`POST /api/session.history`（补历史）、`POST /api/host.describe`（探活）。

这两条流**逐字段覆盖** petween `event-normalizer.ts` 的全部输入（`session/event.event` 与 cordis 载荷完全一致，仅多一个可忽略的 `view` 字段）。风险：这是 DSH 的内部契约，随 rc 版本演进、无稳定承诺——桥必须单独隔离 + 探活降级。精确帧格式、连接生命周期与 9 处「契约不一致必须做转换」的要点见 03 号文档。

## 4. 技术选型决策

- **Electron（推荐）**：main 进程就是完整 Node 24，现有 host 代码（node:http）+ WS 桥零重写；透明窗口/穿透/托盘生态最成熟。当前 stable 44.x。代价 ~50-100MB 安装包。
- **Tauri（否决）**：host 逻辑要么 sidecar Node（双运行时复杂度反而升）要么 Rust 重写 ~5000 行，不值。
- 原规格「禁止 Electron/Tauri」是 **V1 插件形态**的决策（防插件带重框架进 DSH 浏览器环境）；桌面版是独立产品形态，不受该条约束。此决策已于 2026-09-12 由用户发起评估并采纳独立仓库路线。

## 5. 主要风险（按优先级）

1. **点击穿透的焦点缺陷**（electron#33281）：焦点在别的应用时 `forward:true` 的 mousemove 转发可能停摆——恰好是桌宠核心场景。缓解：main 进程光标轮询（200-500ms）+ 宠物包围盒上报做兜底切换。详见 04 号文档 §2。
2. **DSH `/api` 契约无稳定承诺**：桥接层单独成模块、探活 + 降级 idle（纯装饰模式），DSH 不在也能跑。
3. **双形态维护**：桌面壳仓库通过 git submodule 引 petween（单一上游不分叉），壳内尽量零改动 petween；必要回流改动在 submodule 内 commit→push→外层 bump 指针。petween 侧可选补丁清单见 02 号文档 §6。
4. **Windows 透明窗口机型差异**：个别机器硬件加速下透明失效，但盲目禁 GPU 反而破坏穿透（electron#48064）——默认开硬件加速，留命令行兜底开关。
5. **无代码签名 SmartScreen**：每个新版本首跑弹「Windows 已保护你的电脑」，README 写明「更多信息→仍要运行」。

## 6. 已否决/搁置的方案

- **npm 产物消费**：petween 的 exports 面向 DSH（host 插件入口 + `__ModuleLoader__` 工厂包），对桌面壳不可用；MVP 走 file: 依赖 + deep import `src/`，P1-P3 产物化补丁可推迟（见 02 号文档 §6）。
- **headless DSH 做状态源**：headless 是一次性 CLI 问答，无常驻服务。
- **MVP 阶段移植 petween-physics**：physics 核心 cordis-free 可平移，但视口语义要从「DSH 网页视口」改为「OS 屏幕/窗口边界」——放到完整版阶段。
