# AGENTS.md — Petween Desktop

> 本文件面向编码智能体（zcode / 新会话入口）。**开始任何工作前先读完本文件**，再按需读 docs/。

## 1. 项目定位

Petween 的独立桌面版：Electron 壳 + DSH 状态桥，把现有 DSH Web UI 桌宠插件（`vendor/petween`）以**零改动装配级复用**的方式变成 Windows 桌面应用——透明置顶全屏窗口渲染宠物、普通窗口承载设置编辑器、main 进程跑 petween host 业务逻辑（node:http 本地服务）+ WebSocket 桥接本地 DSH 的 agent 会话事件流。

产品语义不变：宠物仍联动 DSH 的 agent 状态（thinking/working/waiting/success/error）；DSH 不在时退化为纯装饰模式（idle）。

## 2. 仓库关系与工作流（最重要的规则）

```
petween-desktop/            ← 本仓库（独立 git，Electron 壳 + 文档 + 计划）
├── vendor/petween          ← git submodule → github.com/Traveritas/petween（锁定 6ed667e）
└── vendor/petween-physics  ← git submodule → github.com/Traveritas/petween-physics（锁定 0bbc914）
```

- **petween 与 petween-physics 都是唯一上游，不允许分叉**。改动在 submodule 内 commit → push 上游 → 本仓库 bump 指针。physics 的双宿主约定（`./desktop` 入口 + 三纪律）见其 README。
- physics submodule 无需 install/build（桌面源码消费，其依赖由根 node_modules 满足）；petween submodule 仍需 install+build（editor.js 产物）。
- **MVP 目标是零改动 petween**（装配级复用已核实可行，见 docs/02）；petween 侧可选补丁清单（P0~P3）在 docs/02 §6，做则回流。
- 本仓库产物发布不影响 petween 的 DSH 插件形态；两形态共享同一份 core 演进。
- submodule 基线：`git submodule update --init --recursive`（clone 后必跑，AGENTS 会话开始时如果 vendor/petween 是空目录就是这个原因）。

## 3. 文档导读（按此顺序读）

| 文档 | 内容 | 何时读 |
|---|---|---|
| `docs/01-eval.md` | 可行性评估总报告（六轮子智能体调研结论） | 了解全局与风险 |
| `docs/02-architecture.md` | 目标架构 + **host/client 装配清单** + 工程边界 + dev/prod 同源设计 | 写任何装配代码前 |
| `docs/03-dsh-bridge-spec.md` | DSH 状态桥规格级契约（帧格式/生命周期/9 条转换） | 写 dsh-bridge 前，**不需要再读 DSH 源码** |
| `docs/04-electron-notes.md` | Electron 44 技术要点（透明窗/穿透/托盘/打包/测试，含已知坑与 issue 号） | 写壳层代码前 |
| `docs/05-mvp-plan.md` | **执行入口**：Phase 0~9 任务清单 + 验收标准 + v0.1.0 里程碑评审 | 任何时候——当前进度记录于此 |
| `docs/06-zcode-connector.md` | zcode 连接器规格（事件映射/传输与端口发现/安装卸载/watchdog/观察项） | 改 connectors/ 下任何代码前；做其他 Agent 连接器时作模板 |

## 4. 关键架构决策速览

1. **Electron 44.x**（main = 完整 Node 24，现有 host 代码零重写）。Tauri 已否决（详见 docs/01 §4）。原 petween 规格「禁止 Electron/Tauri」是 V1 插件形态决策，**桌面版不受该条约束**——不要被 `vendor/petween` 内旧文档的禁令误导。
2. **全程同源**：petween client 侧 HTTP 全是根相对路径，prod 两窗口 `loadURL('http://127.0.0.1:<random>/...')`，dev 用 electron-vite `server.proxy` 代理 `/api/petween`、`/api/petween-desktop`、`/api/petween-physics`、`/petween-assets` 到 local-server（编辑器 iframe 直接指向 local-server origin，不走代理）——这是「零改动 petween」的前提。
3. **overlay 全屏透明窗**：`setBounds(display.bounds)` 铺满（**不用 fullscreen/maximize**）、`alwaysOnTop('screen-saver')`、`focusable:false`；MVP 单显示器单窗。
4. **点击穿透三层**：`setIgnoreMouseEvents(true,{forward:true})` + renderer hit-test（数据源优先 StageSnapshot 的 `bodyRect`）+ **main 光标轮询兜底（必须做**，焦点在别的 App 时转发停摆，electron#33281）+ 4~8px 滞回。
5. **状态桥双流**：mux 流给 `session/event`，host 流给 `session-removed/session-status/agent-error`——**mux 上没有 disposed 信号**，单开一条流是错的。契约转换共 9 条，逐条列在 docs/03 §7。
6. **状态源用 aggregate 模式**（不装 CurrentSessionSource，petween 已支持的 fallback 自动生效）；MVP 不做「跟随 DSH 当前会话」。
7. **数据目录独立**：`app.getPath('userData')/petween-home/`（与 `~/.dsh/petween` 不共享，防双实例写冲突）；「从 DSH 导入」用 petween 现成 `migrateLegacyHome`，用户主动触发。
8. **不 import `vendor/petween/src/client/index.ts`**（那是 DSH slot 注册）；overlay 入口自己 mount `PetOverlay`（纯组件）。设置页直接用 host 伺服的 `/petween-editor/`（`lib/editor.js` 自包含 IIFE）。
9. **main 薄壳化**：Electron API 调用收敛到少数模块，业务逻辑纯函数化，vitest node 环境 + `vi.mock('electron')` 直测；渲染栈沿用 petween 既有 jsdom + mocked `element.animate` 模式。单元测试绝不启动 Electron。
10. 已知前置坑：`vendor/petween` 的 node_modules 符号链接因历史目录搬迁**已断**，联调前必须先在 submodule 内 `pnpm install`；编辑器页面依赖 submodule 内 `pnpm run build` 产出的 `lib/editor.js`。
11. **prod 渲染包必须 `resolve.dedupe: ['react','react-dom']`**（已写入 electron.vite.config.ts）：submodule 自带第二份物理 react，rollup 会打进两份 → overlay 挂载即死于 `useState of null`（dev 解析合一所以测不出）。prod 渲染产物改完后务必验证挂载（CDP `--remote-debugging-port` 或后续 Playwright 冒烟）；对透明 overlay 做像素验证的截图进程必须先 `SetProcessDPIAware()`——DPI-unaware 的 GDI 缩放副本抓不到 layered 窗内容。

## 5. 构建与运行

```bash
git submodule update --init --recursive
cd vendor/petween && pnpm install && pnpm run build && pnpm vitest run   # 修复断链 + 基线验证
cd ../.. && pnpm install && pnpm dev                                     # electron-vite 三段式
pnpm typecheck                                                           # tsc 含 petween 源码
pnpm test                                                                # 壳层单测（vitest node 环境）
pnpm dist:win                                                            # petween 构建 → 三段构建 → NSIS+便携版
```

注意：pnpm 10 拦截依赖构建脚本，`pnpm.onlyBuiltDependencies`（electron/esbuild）已写入 package.json；Electron 二进制缺失时跑 `node node_modules/electron/install.js`；electron-builder 下载（Electron zip 等）不走系统代理，需 `HTTPS_PROXY=http://127.0.0.1:7897 pnpm run dist:win`（Clash 混合端口）。

## 6. 当前状态

- 2026-09-12：仓库建立，petween submodule 锁定 b0763e1，评估/规格/计划文档齐备（六轮子智能体调研沉淀）。
- **2026-09-12：Phase 0 完成**（脚手架/联调地基，验收全过）。踩坑记录见 docs/05 Phase 0 实施记录（tsconfig paths 绕 exports、preload 强制 CJS、pnpm 构建脚本白名单、plugin-react 5.x）。
- **2026-09-12：Phase 1 完成**（host 装配 + local-server：四 store/路由/编辑页/状态通道全伺服，编辑器页面真机验收通过，11 壳层单测全绿）。
- **2026-09-12：Phase 2 完成**（overlay 透明置顶窗 + dev proxy + prod 同源伺服；真机验收：宠物可见/动画/位置持久化/重启保持）。
- **2026-09-12：Phase 3 完成**（点击穿透：renderer 信号 + 光标轮询双通道、6px 滞回、拖动保持、#15376/#33281 两个坑位处理；自动化验证过、人工 checklist 留给用户）。
- **2026-09-12：Phase 4 完成**（DSH 状态桥：双流 WS + 9 条转换 + 退避/心跳/重连差集 FSM；假 DSH 端到端验证 SSE 全事件序列 + 真实重连；真 DSH 联测待用户复验）。
- **2026-09-12：Phase 5 完成**（系统集成：单实例锁/托盘/自启/close→hide/DSH 导入；二次启动唤起设置窗与托盘真机验证过）。
- **2026-09-12：Phase 6 打包链落地**（electron-builder NSIS+便携版；`pnpm dist:win` 一键链；便携版真机冒烟全过：随机端口/asar 伺服/穿透/DSH 退避/托盘/干净退出）。**MVP（Phase 0~6）代码侧完成**；待用户复验/拍板项见 docs/05 各 Phase 验收注记与「待用户拍板项」。
- **2026-09-14：穿透 flapping bug 修复**（keep-alive 重申冻结 hover 结论致整窗抖动；hover 有效性绑定 mousemove 年龄，`aa263f3`）。
- **2026-09-14：Phase 7 完成**（桌面设置窗口：单窗四分区 + iframe 内嵌 petween 编辑器；desktop-settings 存储 + /api/petween-desktop 路由；穿透设置化——模式三选/命中外扩/转发开关/自愈重申/救援热键；DSH 桥设置驱动启停。70 用例全绿，真机验收过；连接器架构已调研、实现暂缓）。
- 后续增强入口 = docs/05「后续增强」清单（连接器 Claude Code 首选、petween P0-P2 回流、跟随会话、physics 移植、多显示器、救援热键可配置等）。
- **2026-09-16：Phase 8 完成**（伴生插件宿主 + physics-desktop：companion 注册表/插件分区/设置启停；physics 上游双宿主入口 `./desktop` 已推送 `0bbc914`；本仓库第二 submodule）。
- **2026-09-16（晚）：DSH 真机联测通过（Phase 4 验收关闭）；`dsh web` 断链修复**（profile `link:` 路径与 petween node_modules 均因仓库搬迁悬空，均已修复）；**always-interactive 模式整体移除**（用户拍板：整屏吃鼠标、与救援热键瞬时锁定重叠；残留值归一化为 auto）。
- **2026-09-16（夜）：v0.1.0 里程碑**——五路子智能体综合评审（主进程/渲染层/测试/文档/安全），零 P0、4 个 P1 + 一批 P2 当场修复（打包排除、设置持久化竞态与 flushSync、启动兜底、minWidth 算术、PUT 竞态、跨源写栅栏、测试盲区补齐），89 用例全绿后打标签；评审记录与 backlog 见 docs/05「v0.1.0 里程碑评审」。
- 待办与后续增强入口 = docs/05「后续增强」清单、「v0.1.0 里程碑评审 backlog」与「待用户拍板项」（连接器 Claude Code 首选、petween P0-P2 回流、跟随会话、热键可配置、多显示器等）。~~发版前必做：builder 排除~~（✅ 评审时已修）。
- **2026-09-18：本地发布构建 + prod 双 React P0 修复**：dist 链走通（NSIS+便携版，按用户要求不接 updater/publish）；修复 prod 渲染包双 React（`resolve.dedupe`，dev 测不出的坑，详见 docs/05「2026-09-18」节）；打包版全链路验证（CDP 挂载/精灵图/轮询 + DPI-aware 像素显隐差分 + 设置窗五分区）。
- **2026-09-18（晚）：Phase 9 zcode 连接器完成、真机验收通过**（规格 docs/06；StateRelay 缝 + 伪造 DSH 信封，petween 零改动；curl cfg 端口发现 + 合并安装 + per-session watchdog；131 用例全绿含真实 curl 端到端冒烟；用户确认功能正常）。同晚追加：**跟随模式**（`followLatestUser`——多会话只联动最近用户主动事件过的会话，焦点代理/退休/重放见 docs/06 §3.1）；**思考/工作不换图定性为 §15.2 设计默认**（`changePoseWithinActive=false`，已翻转用户活配置，编辑器「高级与互动」有开关；上游默认值改不改待拍板）。v0.2.1 产物在 `dist-0.2.1/`。注意：zcode hooks 配置**客户端启动时读取**（运行中不热加载，spike 实证）。
- **2026-09-18（深夜）：Phase 10 统计泡泡 HUD 代码完成**（思考用时/编辑行数泡泡，docs/05 Phase 10 + docs/06 §8：hook stdin 转发 `--data-binary @-` + 端点双格式解析（spike 实证 stdin 双命名载荷，PreToolUse 即带 toolInput）+ 连接器无关 stats 账本（记账在 follow 门控之前）+ `GET /api/petween-desktop/stats` + BubbleHost 样式/动画注册表 + stats-hud companion（纯 reducer 可测）；186 用例全绿；**真机待用户重装 hooks + 重启 zcode 验收**——旧格式 hooks 期间宠物联动照旧、只是无泡泡。对话泡泡拍板为独立插件（复用 BubbleHost）。
- petween 基线：55 测试文件 / 1044 用例全绿（`6ed667e` 起 `changePoseWithinActive` 默认 true——2026-09-18 用户拍板，桌面/DSH 两宿主共用）；petween-physics 基线：10 文件 / 166 用例。

## 7. 给编码智能体的原则

- 先读 docs/05 的当前 Phase 再动手；每 Phase 的验收标准不过不进下一个。
- 改 petween 源码前先自问三遍：真的不能用装配注入解决吗？（02 号文档的清单里几乎都有注入缝）
- 所有 DSH 契约疑问查 docs/03，不要凭记忆猜帧格式。
- Electron 行为疑问查 docs/04（含 issue 号），尤其穿透相关的三个已知坑。
- 完成任何阶段后在 docs/05 勾选条目并在本节追加一行状态记录。
