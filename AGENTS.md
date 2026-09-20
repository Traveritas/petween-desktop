# AGENTS.md — Petween Desktop

> 本文件面向编码智能体（zcode / 新会话入口）。**开始任何工作前先读完本文件**，再按需读 docs/。

## 1. 项目定位

Petween 的独立桌面版：Electron 壳 + DSH 状态桥，把现有 DSH Web UI 桌宠插件（`vendor/petween`）以**零改动装配级复用**的方式变成 Windows 桌面应用——透明置顶全屏窗口渲染宠物、普通窗口承载设置编辑器、main 进程跑 petween host 业务逻辑（node:http 本地服务）+ WebSocket 桥接本地 DSH 的 agent 会话事件流。

产品语义不变：宠物仍联动 DSH 的 agent 状态（thinking/working/waiting/success/error）；DSH 不在时退化为纯装饰模式（idle）。

## 2. 仓库关系与工作流（最重要的规则）

```
petween-desktop/            ← 本仓库（独立 git，Electron 壳 + 文档 + 计划）
├── vendor/petween          ← git submodule → github.com/Traveritas/petween（锁定 8190ae6 = 50942a5 + 光标两修 f21d904/8190ae6）
└── vendor/petween-physics  ← git submodule → github.com/Traveritas/petween-physics（锁定 0a83a24）
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
| `docs/05-mvp-plan.md` | **执行入口**：Phase 0~16 任务清单 + 验收标准 + v0.1.0 / v0.4.0 里程碑评审 | 任何时候——当前进度记录于此 |
| `docs/06-zcode-connector.md` | zcode 连接器规格（事件映射/传输与端口发现/安装卸载/watchdog/观察项） | 改 connectors/ 下任何代码前；做其他 Agent 连接器时作模板 |
| `docs/07-cc-connector.md` | Claude Code 连接器规格（共享层/CC 侧事实/事件映射/session-end/观察项） | 改 cc-* 连接器代码前 |
| `docs/08-codex-connector.md` | Codex 连接器规格（hooks.json 命令串形态/turn_id/信任机制/task_complete 直取） | 改 codex-* 连接器代码前 |

## 4. 关键架构决策速览

1. **Electron 44.x**（main = 完整 Node 24，现有 host 代码零重写）。Tauri 已否决（详见 docs/01 §4）。原 petween 规格「禁止 Electron/Tauri」是 V1 插件形态决策，**桌面版不受该条约束**——不要被 `vendor/petween` 内旧文档的禁令误导。
2. **全程同源**：petween client 侧 HTTP 全是根相对路径，prod 两窗口 `loadURL('http://127.0.0.1:<random>/...')`，dev 用 electron-vite `server.proxy` 代理 `/api/petween`、`/api/petween-desktop`、`/api/petween-physics`、`/petween-assets` 到 local-server（编辑器 iframe 直接指向 local-server origin，不走代理）——这是「零改动 petween」的前提。
3. **overlay 全屏透明窗**：`setBounds(display.bounds)` 铺满（**不用 fullscreen/maximize**）、`alwaysOnTop('screen-saver')`、`focusable:false`；MVP 单显示器单窗。
4. **点击穿透三态机（2026-09-19 重构）**：interactive（宠物上/拖拽）/ forward（宠物包围盒 +96px 进带、+128px 出带滞回，WH_MOUSE_LL 转发钩子**只在带内安装**——常驻会闪他窗光标，electron 已知 bug 族）/ plain（纯穿透零钩子，默认态）；renderer hit-test（StageSnapshot bodyRect 优先）+ main 光标轮询兜底（electron#33281）。overlay 创建后一次性 `setOpacity(254/255)` 钉住 layered_（防 interactive 态摘 WS_EX_LAYERED 引发 Chromium 遮挡冻结，详见 docs/05 v0.3.13 节）。
5. **状态桥双流**：mux 流给 `session/event`，host 流给 `session-removed/session-status/agent-error`——**mux 上没有 disposed 信号**，单开一条流是错的。契约转换共 9 条，逐条列在 docs/03 §7。
6. **状态源用 aggregate 模式**（不装 CurrentSessionSource，petween 已支持的 fallback 自动生效）；MVP 不做「跟随 DSH 当前会话」。
7. **数据目录独立**：`app.getPath('userData')/petween-home/`（与 `~/.dsh/petween` 不共享，防双实例写冲突）；「从 DSH 导入」自写 `legacy-import.ts`（copy-if-absent 绝不覆盖——petween 的 `migrateLegacyHome` 目标目录存在即 skip，不可用于运行时导入，见 docs/05 Phase 5），用户主动触发。
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

注意：pnpm 10 拦截依赖构建脚本，`pnpm.onlyBuiltDependencies`（electron/esbuild）已写入 package.json；Electron 二进制缺失时跑 `node node_modules/electron/install.js`；electron-builder 下载（Electron zip 等）不走系统代理，需 `HTTPS_PROXY=http://<本地代理地址> pnpm run dist:win`（本机代理环境）。

## 6. 当前状态

- 2026-09-12：仓库建立，petween submodule 锁定 b0763e1，评估/规格/计划文档齐备（六轮子智能体调研沉淀）。
- **2026-09-12：Phase 0 完成**（脚手架/联调地基，验收全过）。踩坑记录见 docs/05 Phase 0 实施记录（tsconfig paths 绕 exports、preload 强制 CJS、pnpm 构建脚本白名单、plugin-react 5.x）。
- **2026-09-12：Phase 1 完成**（host 装配 + local-server：四 store/路由/编辑页/状态通道全伺服，编辑器页面真机验收通过，11 壳层单测全绿）。
- **2026-09-12：Phase 2 完成**（overlay 透明置顶窗 + dev proxy + prod 同源伺服；真机验收：宠物可见/动画/位置持久化/重启保持）。
- **2026-09-12：Phase 3 完成**（点击穿透：renderer 信号 + 光标轮询双通道、6px 滞回、拖动保持、#15376/#33281 两个坑位处理；自动化验证过、人工 checklist 留给用户）。
- **2026-09-12：Phase 4 完成**（DSH 状态桥：双流 WS + 9 条转换 + 退避/心跳/重连差集 FSM；假 DSH 端到端验证 SSE 全事件序列 + 真实重连；真 DSH 联测待用户复验）。
- **2026-09-12：Phase 5 完成**（系统集成：单实例锁/托盘/自启/close→hide/DSH 导入；二次启动唤起设置窗与托盘真机验证过）。
- **2026-09-12：Phase 6 打包链落地**（electron-builder NSIS+便携版；`pnpm dist:win` 一键链；便携版真机冒烟全过：随机端口/asar 伺服/穿透/DSH 退避/托盘/干净退出）。**MVP（Phase 0~6）代码侧完成**；待用户复验/拍板项见 docs/05 各 Phase 验收注记与「待用户拍板项」。
- **2026-09-14：穿透 flapping bug 修复**（keep-alive 重申冻结 hover 结论致整窗抖动；hover 有效性绑定 mousemove 年龄，`726209e`）。
- **2026-09-14：Phase 7 完成**（桌面设置窗口：单窗四分区 + iframe 内嵌 petween 编辑器；desktop-settings 存储 + /api/petween-desktop 路由；穿透设置化——模式三选/命中外扩/转发开关/自愈重申/救援热键；DSH 桥设置驱动启停。70 用例全绿，真机验收过；连接器架构已调研、实现暂缓）。
- 后续增强入口 = docs/05「后续增强」清单（连接器 Claude Code 首选、petween P0-P2 回流、跟随会话、physics 移植、多显示器、救援热键可配置等）。
- **2026-09-16：Phase 8 完成**（伴生插件宿主 + physics-desktop：companion 注册表/插件分区/设置启停；physics 上游双宿主入口 `./desktop` 已推送 `0bbc914`；本仓库第二 submodule）。
- **2026-09-16（晚）：DSH 真机联测通过（Phase 4 验收关闭）；`dsh web` 断链修复**（profile `link:` 路径与 petween node_modules 均因仓库搬迁悬空，均已修复）；**always-interactive 模式整体移除**（用户拍板：整屏吃鼠标、与救援热键瞬时锁定重叠；残留值归一化为 auto）。
- **2026-09-16（夜）：v0.1.0 里程碑**——五路子智能体综合评审（主进程/渲染层/测试/文档/安全），零 P0、4 个 P1 + 一批 P2 当场修复（打包排除、设置持久化竞态与 flushSync、启动兜底、minWidth 算术、PUT 竞态、跨源写栅栏、测试盲区补齐），89 用例全绿后打标签；评审记录与 backlog 见 docs/05「v0.1.0 里程碑评审」。
- 待办与后续增强入口 = docs/05「后续增强」清单、「v0.1.0 里程碑评审 backlog」与「待用户拍板项」（连接器 Claude Code 首选、petween P0-P2 回流、跟随会话、热键可配置、多显示器等）。~~发版前必做：builder 排除~~（✅ 评审时已修）。
- **2026-09-18：本地发布构建 + prod 双 React P0 修复**：dist 链走通（NSIS+便携版，按用户要求不接 updater/publish）；修复 prod 渲染包双 React（`resolve.dedupe`，dev 测不出的坑，详见 docs/05「2026-09-18」节）；打包版全链路验证（CDP 挂载/精灵图/轮询 + DPI-aware 像素显隐差分 + 设置窗五分区）。
- **2026-09-18（晚）：Phase 9 zcode 连接器完成、真机验收通过**（规格 docs/06；StateRelay 缝 + 伪造 DSH 信封，petween 零改动；curl cfg 端口发现 + 合并安装 + per-session watchdog；131 用例全绿含真实 curl 端到端冒烟；用户确认功能正常）。同晚追加：**跟随模式**（`followLatestUser`——多会话只联动最近用户主动事件过的会话，焦点代理/退休/重放见 docs/06 §3.1）；**思考/工作不换图定性为 §15.2 设计默认**（`changePoseWithinActive=false`，已翻转用户活配置，编辑器「高级与互动」有开关；上游默认值已拍板：`6ed667e` 起默认 true，见下方基线行）。注意：zcode hooks 配置**客户端启动时读取**（运行中不热加载，spike 实证）。
- **2026-09-18（深夜）：Phase 10 统计泡泡 HUD 代码完成**（思考用时/编辑行数泡泡，docs/05 Phase 10 + docs/06 §8：hook stdin 转发 `--data-binary @-` + 端点双格式解析（spike 实证 stdin 双命名载荷，PreToolUse 即带 toolInput）+ 连接器无关 stats 账本（记账在 follow 门控之前）+ `GET /api/petween-desktop/stats` + BubbleHost 样式/动画注册表 + stats-hud companion（纯 reducer 可测）；186 用例全绿；**真机待用户重装 hooks + 重启 zcode 验收**——旧格式 hooks 期间宠物联动照旧、只是无泡泡。对话泡泡拍板为独立插件（复用 BubbleHost）。
- **2026-09-19：Phase 11 动画编辑器独立窗口（V1.2 骨架）代码完成**（上游 `4fa4de8`：`/petween-animator/` 自包含工作台页 + static-page 工厂 + animation-draft 共享提取 + AnimatorStore，1057 用例全绿；桌面：animator-window（按需创建/close→hide）+ 托盘/设置双入口 + builder/装配，194 用例全绿；手感升级三批 = Phase 12 scrub/zoom → 13 多选/undo/菜单 → 14 曲线编辑器，详见 docs/05 Phase 11；**真机验收暂缓——2026-09-20 用户拍板编辑器线搁置，随线顺延**）。
- **2026-09-19（晚）：真机反馈修复批全部关闭**——光标闪动三连修（终局：`setIgnoreMouseEvents` 转发的 WH_MOUSE_LL 钩子改为宠物近带常驻（+96/128px 滞回），否则纯穿透零钩子——Electron 已知「flickering cursor」bug 族，`a32e2e5`）；预览穿插（stageBox 收容）；退出报错（destroyed 窗口上读 webContents，捕获引用+守卫，`bd31993`）；动画编辑器重构为三栏 DCC 工作台（库|视口+时间轴|属性栏，检查器右栏停靠，上游 `50942a5`）。用户逐项真机复验通过。桌面基线 202 用例。另：用户授权「需要打包时直接 taskkill Petween」。
- **2026-09-19：Phase 12 手感一批代码完成**（上游 `900f1d6`：sampleTimelineAt 采样预览（与播放逐像素一致）+ PreviewSession.scrubDefinition 直写舞台层 + Ctrl+滚轮光标锚缩放/滚轮平移 + ms 自适应标尺（1-2-5 步进）+ 目标吸附（帧/事件/播放头，Alt 临时禁用，擦洗排除自身）+ Space 播放/停止；TimelineEditor 全部可选 props，V1.1 行为零变化；1088 用例全绿。桌面仅 bump 指针；**真机验收暂缓（随编辑器线顺延）**）。
- **2026-09-19（泡泡反馈批，v0.2.5→0.2.6）**：用户确认写入泡泡真机正常；思考计时改整秒显示（v0.2.3）；**入场/出场动画拆分为独立选项**（设置卡双下拉；close 时先摘入场类再加出场类，不依赖级联顺序；旧 `animationId` 存量按 LEGACY_BUNDLED_EXITS 迁移）；「随风」慢淡出出场 + 「飘落」入场一对（出场动画新增 `durationMs`，宿主按其移除元素）。20 种组合，202 用例全绿。
- **2026-09-19（泡泡线第二批，v0.3.0）**：多会话泡泡分列排布（BubbleHost 多列 + 共享单例 + assignColumnSlots 纯函数；multiSession 默认开）+ 完成提醒泡泡（账本回合追踪 → turn-summary 事件）+ 对话泡泡（rollout model-io 流式前扫，单行内嵌全量请求上下文 >1MB 故无固定尾窗；markdown 剥离/160 字截断在 main 边界；GET /dialogue 唯一内容级通道）+ 里程碑宠物动画（每 N 新增行 builtin:click-pop，10s 节流）。224 用例全绿；**✅ 2026-09-20 真机验收通过**（详见 docs/05 Phase 10 第二批）。
- **2026-09-19（泡泡反馈批 2，v0.3.1）**：泡泡重排渐变（left/top 260ms 过渡 + 首次定位免过渡）、列间距收紧（宠物宽/2+110）；回复泡泡独立到宠物左侧 + 专属样式 + 3 行裁剪、完成泡泡独立到宠物下侧 + 专属样式——布局模型升级为 column/left/below 三区域（互不推挤，固定栈容量 2）。224 用例全绿。
- **2026-09-19（泡泡反馈批 3，v0.3.2）**：间距真凶 CDP 实测定位——宠物靠屏幕缘时侧列被视口钳制压到宠物身上；assignColumnSlots 升级 room-aware（按剩余空间贪心选边）。合成场景复测 petOverlaps=0。227 用例全绿。诊断手法：--remote-debugging-port + 合成事件 + Runtime.evaluate 量几何。
- **2026-09-19（泡泡反馈批 4，v0.3.3）**：列布局重定为用户规格——列间按边框最近距离固定间隙（可调，默认 24px）、整组按宠物居中（packColumnBand）、超界整体内移。CDP 复测边框间隙精确 24px、全列在界内。228 用例全绿。
- **2026-09-19（泡泡反馈批 5，v0.3.4）**：四类泡泡（思考/编辑/回复/完成）全维度独立配置——样式/入场/出场/停留时长 per-type（types 分组 + migrateTypeConfigs 旧键迁移外观不变），设置卡每类型一行。231 用例全绿。
- **2026-09-19（泡泡反馈批 6，v0.3.5）**：修复 v0.3.4 引入的思考/编辑泡泡早夭回归（spawnWith 把 holdMs 错当弹出即关的定时器；生命周期应全由 hide 命令驱动）。CDP 验证：思考泡泡存活 3.6s+ 计时递增、编辑泡泡跨多次写入存活。教训：hold 有两种语义（完成后停留 vs 显示总时长），refactor 时混用了。
- **2026-09-19（泡泡反馈批 7，v0.3.6）**：完成泡泡不退场修复——v0.3.5 补参数的字符串替换静默未匹配（可选参数编译器拦不住）；改为布尔 autoClose 标志、时长由 spawnWith 内部取。CDP 验证 4s+淡出后清场。教训：批量字符串补丁必须 grep 复核落点。
- **2026-09-19（泡泡反馈批 8，v0.3.7）**：泡泡按内容类型优化形状——宿主挂 kind 类，皮肤 CSS 按类型精修（回复：药丸→14px 卡片/段落行距/题注式标签；完成：16px 卡片）；computed-style 实证生效。另实测 zcode rollout 会整体重置（疑上下文压缩触发），重置后首回合无回复摘要（可接受）。
- **2026-09-19（泡泡反馈批 9，v0.3.8）**：修复编辑泡泡被退场条目吞掉——spawn 按 key 去重不排除 closing，旧泡泡 hold+出场窗口（随风≈2.5s）内吞掉继任者（agent 1~3s 工具节奏必中；自 v0.3.0 潜伏）。去重跳过 closing，新旧共存。另：主题级进出场复杂变换（打字机等）已评估入 backlog（docs/05 后置项）。
- **2026-09-19（泡泡反馈批 10，v0.3.9）**：随风/飘落浮动包络随高度变化——translate+rotate 双通道摆动，出场递增（0→17px）、入场递减（14→0px）；CDP 采样实证两向包络。
- **2026-09-19（泡泡反馈批 11，v0.3.10）**：随风/飘落节奏微调——飘落 900ms 快收敛（65% 归零）、随风 1400ms 长淡出（-54px/-18px 终点）。CDP 采样实证。
- **2026-09-19（泡泡反馈批 12，v0.3.11）**：随风/飘落动画按用户偏好退回 v0.3.8 版本（钟摆等幅摆动、640/1000ms）；高度包络两轮方案废弃（git 历史可回捞）。
- **2026-09-19（泡泡反馈批 13，v0.3.12）**：列位置记忆——槽位按会话身份固定（任务栏模式，非 Alt-Tab MRU），活跃度不再重排列；新会话复用空槽（回位倾向）。焦点驱动布局移除。CDP 验证交替编辑三轮位置稳定。233 用例全绿。
- **2026-09-19（夜）：physics 可见像素碰撞箱**（上游 `0a83a24`，physics 0.3.0，默认关）：`collision.ignoreTransparentPixels` + `alphaThreshold`——姿势图 alpha 紧致包围盒（canvas ≤512px 降采样扫描，URL×阈值缓存）在 bodyRect insets 之上再剥掉图片文件透明边缘；(petId,poseKey)→宠物记录（逐问取新）→资产 URL，零 petween 改动；拖拽起步预热/姿势身份逐帧检测/陈旧答案守卫。physics 190 + 桌面 233 用例全绿；**✅ 2026-09-20 真机验收通过**（详见 docs/05 同日节）。
- **2026-09-19（穿透修复，v0.3.13）**：拖动/悬停宠物冻住其他应用动画的根因 = interactive 态 `setIgnoreMouseEvents(false)` 同时摘 `WS_EX_LAYERED`，全屏置顶窗遂成 Chromium 遮挡判定（`IsWindowVisibleAndFullyOpaque`）中的"完全不透明遮挡者"，底下 Chromium/CEF 应用渲染全停；样式恢复走裸 `SetWindowLong` 静默无事件，被冻结窗口又移出 LOCATIONCHANGE 钩子集合——只有切前台触发重算。修复 = overlay 创建后一次性 `setOpacity(254/255)` 钉住 Electron 内部 `layered_`（此后任何穿透模式保留 layered+alpha<255，永不算遮挡者）。隔离实验（不碰真 app）：受害者窗冻 9.5s→修复后 1.1s 恢复、透明像素无黑块。235 用例全绿（+overlay-window 2）；**✅ 2026-09-20 真机验收通过**（详见 docs/05 同日节）。
- **2026-09-19（健壮性，v0.3.14）**：`stdout-epipe-guard`——主进程 stdout/stderr 挂 EPIPE 吞噬监听；诱因 = 从后台脚本/控制台启动且管道先亡时（实测：bash 后台启动应用、会话退出），主进程每次 console.log（穿透状态切换/DSH 桥重试均打日志）抛 EPIPE 未捕获异常 → "A JavaScript error occurred in the main process" 弹窗刷屏。入口最先调用，其余错误码照抛。239 用例全绿（+4）。另：方案 C（小窗化）难度评估入 docs/05 后置项——A 之后边际收益低，搁置。
- **2026-09-20（泡泡样式第四批，v0.3.15）**：新增漫画（墨线对话气泡+指向宠物的尾巴，三种朝向按放置位切换）/便签（胶带+楷体+独立 rotate 属性微倾——飘落/随风动画期间被压制的已知取舍）/霓虹（青辉光毛玻璃）/墨金（衬线+金栏）四个 CSS-only 皮肤；`renderStandard` 共享渲染器提取（内置三皮肤同构重构，行为零变化）。视觉 harness 两轮审查（尾巴朝向边框组合第一轮抓错修正）。241 用例全绿。
- **2026-09-20（v0.4.0 里程碑）**：碰撞箱/遮挡修复/泡泡线（含皮肤四批）真机验收通过，动画编辑器线拍板搁置；五路子智能体综合评审（主进程/渲染层/测试/文档/安全）**零 P0、5 P1 全修**——follow 模式焦点切换吞事件、设置页 PUT 重试死代码、`animationId` 存量迁移丢失（v0.2.5 契约在 v0.3.x 重构中丢失）、**routes-host Host 白名单防 DNS rebinding**（收口 v0.1.0 backlog #4；dev 代理加 changeOrigin）、文档失真批（AGENTS 指针/决策 4/决策 7、docs/02/04 proxy 清单、docs/06 §8.5 损坏文本）；P2 当场修 14 项（zcode-hooks 精确归属/串行化/非数组保护/.bak/不强制 enabled、ws maxPayload+NOOP error、legacy-import 失败弹窗、companions.enabled per-id 合并、holdMs=0、bump 入场窗口抑制、三窗导航锁 loopback、hud 环回绕 thinking 兜底等）；**264 用例全绿（+23）后打标签 v0.4.0**。CC 连接器（Phase 15）/Codex 连接器（Phase 16）开工计划落 docs/05 尾部。评审详情与 backlog 见 docs/05「v0.4.0 里程碑评审」节。
- **2026-09-20（晚）：Phase 15 Claude Code 连接器代码完成（v0.5.0）**：spike 实证（本机 CC 2.1.234 + 官方 hooks reference——settings.json 顶层 hooks 键与 zcode 同构、exec 形式 hooks、timeout 单位秒、**热加载无需重启 CC**、prompt_id 即 turnId、matcher 同族语义）；共享层抽取（`hook-connector.ts` 引擎 + `config-io.ts` + `route-helpers.ts`，zcode 三文件薄壳化，行为零变化）；cc-connector（session-end 即时 dispose——排在惰性定时器之前防二次 dispose、PermissionRequest+Notification 共用 waiting）、cc-hooks（settings.json 合并安装/卸载，v0.4.0 四加固全量）、cc-routes（stdin JSON 解析）；设置卡 HookConnectorCard 泛型双实例。264→302 用例全绿（+38）。**同日追加（v0.5.1）：对话泡泡解绑**——dialogue 路由多源化（sources[] 顺序探测）+ cc-dialogue-source（transcript 父链回溯精确回合匹配，spike 实证 user 行带 promptId/父链 100% 可达；hook 载荷 transcript_path 喂注册表 + projects 扫描兜底）+ dialogue-text.ts 归约共享；HUD 零改动，zcode 行为不变。312 用例全绿；**真机验收待用户：设置→连接→Claude Code 安装 hooks（无需重启 CC，泡泡四件套含回复文本全点亮）**。规格 docs/07（§9）。
- petween 基线：64 测试文件 / 1111 用例全绿（`8190ae6` = `50942a5`（V1.2 工作台 + P12 scrub/zoom + P13 多选/undo + P14 曲线编辑器）+ 光标两修 `f21d904`/`8190ae6`；`6ed667e` 起 `changePoseWithinActive` 默认 true——2026-09-18 用户拍板，桌面/DSH 两宿主共用）；petween-physics 基线：12 文件 / 190 用例（`0a83a24`）。
- **2026-09-20（夜）：Phase 15 两路评审修复（0 P1、6 P2）+ Phase 16 Codex 连接器代码完成（v0.6.0）**：评审（引擎保真+安全面）确认抽取逐字保真、零 P1，修 6 个 P2（quit 漏 ccConnector.dispose、cc-dialogue 全量驻留改流式+64MB 总帽、noteTranscript 路径校验防注册表投毒、dialogue 多源容错、顶层 hooks 非对象拒绝、卸载清 .petween-bak——317 用例）后推送。Phase 16：spike 推翻「command hooks 家族」预判——**Codex 0.154 原生 hooks 即 CC 兼容引擎**（codex-rs `ClaudeHooksEngine`，`~/.codex/hooks.json` 命令串形态经 cmd.exe /C，本机 deja-vu hooks 共存实测）；`turn_id` 原生回合 id、`transcript_path` 可 null、**hooks 哈希信任机制（安装后 Codex 请求一次确认）**；Interrupt→session-start（打断立即 idle）、SessionEnd 即时 dispose、无 Notification；对话泡泡由 rollout `task_complete`（`turn_id`+`last_agent_message`）直取——Phase 15 解绑即刻兑现。设置卡三实例（zcode/CC/Codex）。346 用例全绿（+29）；**真机验收待用户：CC 与 Codex 一并（docs/05 Phase 15/16 验收清单）**。规格 docs/08。
- **2026-09-20（验收反馈修，v0.6.1）**：真机报 CC install 403 + 取消勾选无效——根因一是 dev 代理只 changeOrigin 改 Host 不改 Origin，v0.4.0 后 Origin↔Host 写栅栏在 dev 全部 403（install/PUT 全灭，勾选从未持久化）；修复 = 代理 headers.origin 重写为目标源（两栅栏同源一致）。根因二是连接器 disable 从未接线生命周期；修复 = 引擎新增 reset()（逐会话 emit disposed + 清账本行，宠物立即释放而非戴着最后表情等 watchdog），onChange 接线三连接器的启停翻转。348 用例全绿（+reset/同源栅栏 2）。
- **2026-09-20（Codex 验收反馈修，v0.6.2）**：真机 Codex 启动日志两条我们的问题——①matcher 被拒（`invalid matcher: look-around is not supported`）：**Codex 用 Rust regex crate 编译 matcher，不支持前瞻**，CC 家族的负向前瞻「其他工具」模式整组被丢弃；修复 = 不注册任何 PreToolUse matcher，单个裸组全量上报 + **路由边界按载荷 tool_name 重归类**（classifyCodexToolKind，并集为 TS 单一事实源，免疫 matcher 语义漂移）。②SessionEnd/Interrupt 超时钳位警告：那两类事件 Codex 钳到 3s，直接写 3。另确认本机 deja-vu hooks 的 `command not found`（反斜杠路径经 bash 被吞）是其自身问题，非我们引入（合并写保留其条目原样，实测完好）。350 用例全绿。
- **2026-09-20（CC 状态污染修，v0.6.3）**：真机报 CC「泡泡正常但宠物状态切换有问题」——ledger 事件序列坐实根因：回合 success 后约一分钟 CC 发 Notification「waiting for your input」闲置提示，被映射成 waiting（等待授权脸），宠物凭空从成功脸翻成等待脸；修复 = 摘除 Notification 注册（docs/07 §6.2 预案兑现），真授权提示 PermissionRequest 不受影响。另用 `codex exec` 复现确认 Codex 的「Hook failed code 1」= deja-vu hook（bash 吞反斜杠），我们的 hook 是 Completed 侧（curl 实弹 204/exit 0 验证）；发现 Codex/zcode 连接器当时处于停用态（v0.6.1 修复后取消勾选真正持久化了）——重启用即恢复。350 用例全绿。
- **2026-09-20（Codex 传输层重做，v0.6.4）**：真机取证（借信任哈希自铸逐条实弹）锁定 curl 根因——**Codex Windows hook 执行器下 curl 读 stdin+网络必挂**（exit 1 空 stderr；stdin 单独通、网络单独通、node 的 stdin+fetch 通）；另两个 cmd 坑：命令首 token 带引号被 /C 引号剥离劈坏（「命令语法不正确」）、正斜杠程序路径被当开关。传输层换 **node sink 脚本**（sink.js 读 stdin → 按 kind 的 cfg 读端口 → fetch POST；命令形态 = node 反斜杠无引号 + sink.js 正斜杠无引号 + kind，deja-vu 同款）；安装时 findNodePath 解析系统 node.exe（缺失安装报错）；cfg 文件仍为 boot 端口载体。归属集补 legacy cfg 名单，修重装堆积 bug（旧三组 matcher 形态永不清除，真机 4 组堆积实证）。端到端（exec 模式）：9 hooks 全 Completed、事件全序列送达、工具任务真建文件。352 用例全绿。信任哈希算法（规范 JSON 的 sha256，存 config.toml `[hooks.state]`）与排障手册入 docs/08 §3.1。CC 侧同轮验证：Notification 修复生效（success 后无幽灵 waiting）、dialogue 端点 turnId 匹配返回正常（回复泡泡数据通路端到端通）。
- **2026-09-20（Phase 15/16 验收关闭）**：用户确认 CC 与 Codex 连接器真机全部正常（「现在没问题了」）。验收过程共追加四批版本修复（v0.6.1 dev 代理 origin 重写 + disable 接线 / v0.6.2 Rust regex matcher 改路由分类 / v0.6.3 CC Notification 污染摘除 / v0.6.4 node sink 传输重做与重装堆积两项），全部根因坐实并记录于 docs/07/08。**连接器三件套（zcode/CC/Codex）至此全部真机验收通过。**

## 7. 给编码智能体的原则

- 先读 docs/05 的当前 Phase 再动手；每 Phase 的验收标准不过不进下一个。
- 改 petween 源码前先自问三遍：真的不能用装配注入解决吗？（02 号文档的清单里几乎都有注入缝）
- 所有 DSH 契约疑问查 docs/03，不要凭记忆猜帧格式。
- Electron 行为疑问查 docs/04（含 issue 号），尤其穿透相关的三个已知坑。
- 完成任何阶段后在 docs/05 勾选条目并在本节追加一行状态记录。
- **2026-09-20（v0.7.0 里程碑）**：五路综合评审 v0.4.0 以来 9 提交——零 P0、1 P1（config-io 瞬时读错误当全新安装可塌缩用户配置）全修 + 18 项 P2 当场修（安全 4/主进程 7/渲染 5/文档 11 + 测试 2 修正），364 用例全绿（+12 含 sink 执行级 e2e）打标签。连接器插件化拍板：暂不（代码级 SDK 已就位，触发式抽取——见 docs/05 v0.7.0 节）。backlog：follow 跨连接器仲裁、翻转接线提纯、e2e 现行形态、敌对形状钉测试。
- **2026-09-20（backlog 好修批，v0.7.1）**：①follow 跨连接器仲裁（引擎 onFocusAcquired/retireFollowTarget + index.ts 三连接器仲裁器——双 CLI 跟随不再两脸摇摆）；②zcode dialogue 源流式化（64 行候选驻留改逐行归约只留最后一条，与 CC 源同 posture）；③DSH bridge 崩溃自动退避重启（此前崩溃后只能靠设置开关复活）；④settings-card fetch 移出 setState updater（StrictMode 双发风险）；⑤敌对形状钉测试（cc/codex 源各 +遍历出根/兄弟前缀/UNC/小写盘符——顺带实证「resolve 先折叠、前缀后查」的出根性质）+ 路由测试 mock 清理。367 用例全绿（+3）。剩余 backlog：companion 重挂载预热、Playwright 冒烟、jsdom 泡泡测试、翻转接线提纯、e2e stdin 形态、屏幕顶部三区域互避。
- **2026-09-21（工程卫生批，v0.7.2）**：整体仓库评审（三路：陌生人视角 7.7/10 / 开发纪律 8.0/60 / 可扩展性六轴）后的三件硬伤修复——①**CI**（.github/workflows/ci.yml：windows-latest，submodule→petween build→install→typecheck+test，README 同款链）；②**LICENSE**（先 CC BY-NC-SA 4.0 后同日改拍 **AGPL-3.0-or-later**——对照同类实证：agent 工具圈全宽松、中文 AI 桌宠圈偏 AGPL，用户选 AGPL 对齐同类主流；package.json license 同步）；③**README 重写**（能力导向首屏、三连接器特性、前置条件 Node≥20/pnpm 10/Windows-only、docs 06-08 入索引、CI 徽章、测试数改活引用治多副本漂移）+ package.json 补 engines/packageManager。**bubble-host jsdom 行为测试还账**（v0.4.0 backlog #1：8 用例钉 v0.3.5/6/8 三个历史 bug 所在层——去重跳过 closing/出场按 exit.durationMs 移除/列与侧栈容量淘汰/dispose 清定时器/首放不滑移）。375 用例全绿（+8）。
- **2026-09-21（许可证终拍）**：用户对照同类项目许可证分布（GitHub 实证：agent 工具圈 MIT/Apache 全宽松、桌宠圈 MIT 与 GPL/AGPL 两极、NC 零样本）后拍板 **AGPL-3.0-or-later**（LICENSE 官方全文 + package.json + README 三处同步）。语义：自由改进/做产品、衍生同协议开源、署名；商用名义合法但强 copyleft 实际劝退公司白嫖。
- **2026-09-21：Phase 17 roamer companion 代码完成**（宠物自主行为：游荡/待机动作/捣乱，详见 docs/05 Phase 17）：零 petween core 改动的第三个 in-tree companion（`src/renderer/companions/roamer/`：纯决策引擎 + 薄 runtime + windows DOM 层 + host 动画装配）；PositionDriver 租约仅走 leg 期间持有（与 physics 抛掷互让）；拉窗/便签/内容池 + 四待机动作 + 冲过/探头（朝向镜像因 pose zoom 校验域无负值砍掉）；三类行为子项全独立开关（`companions.options['roamer']`，3s 轮询热生效）；in-tree 不建仓（用户问询确认，physics 迁移模板已验证）。413 用例全绿（+38）；**真机验收待用户（docs/05 Phase 17 验收清单）**。
