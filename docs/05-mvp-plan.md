# MVP 实施计划与验收清单

> 执行入口文档。每个 Phase 结束跑一次验收再进下一个；「验证方式」里能自动化的自动化，视觉效果人工目检。配套阅读：02（装配）、03（桥规格）、04（Electron 要点）。
> 估算总量：Phase 0~4 = MVP（1~2 周）；Phase 5~6 = 完整版（再 +1~2 周）；physics 移植另计。

## Phase 0：脚手架与联调地基（✅ 2026-09-12 完成）

- [x] `package.json`：`"petween": "link:./vendor/petween"`；声明运行时依赖 `ws`、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-atomic-write`、`fflate`、`react`、`react-dom`；类型 `@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-session`、`@types/react`、`@types/node`；devDeps `electron@^44`、`electron-vite@^5`、`electron-builder`、`typescript`、`vitest`
- [x] `vendor/petween` 里重跑 `pnpm install`（**node_modules 符号链接因旧目录搬迁已断，必须先修**）+ `pnpm run build`（设置页需要 `lib/editor.js`）+ `pnpm vitest run`（确认基线 55 文件 / 1044+ 用例全绿）
- [x] electron-vite 三段脚手架 + tsconfig 对齐四项（`moduleResolution: "bundler"`、`jsx: "react-jsx"`、`lib/target ES2024`、`strict`；main 加 `types:["node"]`；**不要开 petween 没开的高严格项**）
- [x] `resolve.alias` 指 `vendor/petween/src`；renderer 里试 import `client/overlay/PetOverlay.tsx` 编译通过
- [x] 空 main 起 一个普通 BrowserWindow 显示 hello 页

**验收（✅ 2026-09-12）**：`pnpm dev` 起得来；`vendor/petween` 测试全绿；TS 编译含 petween 源码零报错。

**实施记录（踩坑补充）**：
- petween 的 `exports` 只暴露 `.`/`./client`/`./package.json`，`moduleResolution:"bundler"` 遵循 exports → TS 侧深 import `petween/src/...` 被挡。解法：tsconfig 加 `paths: {"petween/*": ["./vendor/petween/src/*"]}`（与 Vite alias 等价）。
- electron-vite 5 在 `"type":"module"` 下把 preload 打成 `index.mjs`，而 `sandbox:true` 不支持 ESM preload（且 main 引用 `index.js` 直接 ENOENT）。解法：`preload.build.rollupOptions.output` 强制 `format:'cjs' + entryFileNames:'[name].js'`。
- pnpm 10 默认拦截依赖构建脚本：package.json 需 `pnpm.onlyBuiltDependencies: ["electron","esbuild"]`，否则 Electron 二进制不下载（`node node_modules/electron/install.js` 可补跑）。
- `@vitejs/plugin-react` 必须 5.x（6.x 要求 Vite 8，与 electron-vite 5 的 Vite 7 不兼容）。

## Phase 1：host 装配 + local-server（✅ 2026-09-12 完成）

- [x] `src/main/local-server.ts`：装配四 store（**全部显式传路径**，数据根 `app.getPath('userData')/petween-home/`）+ `createWriteLock` 共享锁 + `ensurePresetAuthority`（建 store 前跑）+ `ConfigViewStore` + `registerRoutes` + `attachStateChannel` + `registerEditorPage`（**注入 `loadBundle` 读 `vendor/petween/lib/editor.js`**）——装配范本 = `vendor/petween/src/index.ts:57-99`
- [x] `RoutesHost` 适配器：node:http 上 exact 优先 / prefix 最长匹配分发（**参考实现 = `vendor/petween/tests/host/routes.test.ts:80-120`**）→ `src/main/routes-host.ts`
- [x] `server.listen(0, '127.0.0.1')` 随机端口（prod）；dev 固定端口供 proxy（`src/main/dev-port.ts` = 17777，dev 由 `!app.isPackaged` 判定，`PETWEEN_LOCAL_PORT` 可覆盖）
- [x] 单测：装配纯函数 + 路由分发器（node 环境直测，参考 petween tests 的 fake 手法）→ `tests/main/routes-host.test.ts`（6 用例）+ `tests/main/local-server.test.ts`（5 用例：config/meta/editor 页+bundle/资产上传+静态伺服/重启持久化）

**验收（✅ 2026-09-12 真机）**：浏览器开 `http://127.0.0.1:17777/petween-editor/` 完整编辑器渲染（DOM 树 + 截图核验）；`/api/petween/config`、`/api/petween/meta` 正常；资产上传/重启持久化由单测覆盖（server 重启资产仍在）；数据目录独立（`%APPDATA%/petween-desktop/petween-home`，`~/.dsh/petween` 时间戳未动）。

**实施记录**：
- `state-relay.ts` 新增：`StateChannelHost` 奇缝的进程内实现（4 个 `on()` + emit 方法），Phase 1 只挂不响（宠物 idle），Phase 4 桥驱动其 emit。
- local-server 的 `close()` 做成幂等（重启持久化用例复用同一 server 对象）。
- vitest.config.ts 也需要 `petween` alias（与 tsconfig paths / vite alias 三处同源）。

## Phase 2：overlay 窗口（✅ 2026-09-12 完成）

- [x] `src/renderer/overlay/`：~50 行入口（React root + `configHub` + mount `<PetOverlay />`）；**不 import `vendor/petween/src/client/index.ts`**（configHub 是 PetOverlay 内建共享单例，入口更薄）
- [x] dev：electron-vite `server.proxy` 把 `/api/petween`、`/petween-assets` 代理到 local-server（保同源 + HMR）
- [x] prod：overlay 窗口 `loadURL('http://127.0.0.1:<port>/overlay.html')`——local-server 经 `overlay-static.ts` 伺服 out/renderer 构建产物（页面别名 + `/assets` 前缀 + 遍历防护）
- [x] `overlay-window.ts`：04 号文档 §1 的窗口配置（transparent/frame:false/skipTaskbar/focusable:false/setBounds 铺满/alwaysOnTop screen-saver/ready-to-show 再 show/backgroundThrottling:false）
- [x] MVP 只做**主显示器单窗**；`display-metrics-changed` 时重新 setBounds（具名监听器，closed 时移除）

**验收（✅ 2026-09-12 真机）**：配好图片后（API 上传 96x96 PNG + 设 idle 姿势）桌面可见宠物且叠在所有窗口之上；idle sway/breathe 动画在跑；API 写 overlay 位置 → 3s 轮询内宠物移动到新位置；**重启 app 位置/资产/配置全部保持**。拖动手感与「宠物矩形外不挡鼠标」留给 Phase 3（本阶段窗口整体不穿透，符合预期）。

**实施记录**：
- `overlay-static.ts`：prod 同源伺服 electron-vite renderer 产物（`/overlay.html`/`/overlay`/`/overlay/index.html` 三个别名 + `/assets` 前缀）；MIME 表 + resolve/startsWith 双层遍历防护；单测 4 用例。
- dev 下 settings 编辑器无需代理（不是 vite 页面，直接 loadURL local-server 即同源）；proxy 只需覆盖 vite 伺服的 overlay 页面用到的 `/api/petween` + `/petween-assets`。
- 拖动验证以「API 写位置 → 视觉确认移动 → 重启保持」等价覆盖（拖动是 petween 客户端既有行为，上游 1044 用例已覆盖；合成拖动会打断用户前台应用，不做）。

## Phase 3：点击穿透（✅ 2026-09-12 代码完成；人工 checklist 待用户复验）

- [x] `pointer-through.ts` + `pointer-through-logic.ts`：默认 `setIgnoreMouseEvents(true,{forward:true})`，决策纯函数化（12 用例）；IPC 通道 `petween:pointer-signal` 经 preload 白名单（sandbox CJS preload）
- [x] hit-test 数据源：优先 petween StageSnapshot 的 `bodyRect`（`petweenClientService.subscribeStage`，含 `dragging` 标志），DOM 兜底 `document.elementsFromPoint` + `.petween-position` closest
- [x] **光标轮询兜底**（必须）：main `screen.getCursorScreenPoint()` 250ms 轮询 + renderer 上报 bodyRect（client→screen 经 `getContentBounds()` 映射）——渲染信号 800ms 视为陈旧（#33281 停摆场景纯靠轮询）
- [x] 6px 滞回余量防抖动（进入用紧矩形、保持用扩展矩形）；`did-finish-load` 后强制重 apply（#15376）；DevTools 打开时 console 告警
- [x] 拖动语义：snapshot `dragging` 标志 2s 内强制 interactive（拖动中绝不穿透），单测覆盖
- [ ] **人工 checklist（待用户复验，必须关 DevTools）**：① 宠物矩形外点击落到下层窗口/桌面；② 悬停宠物 hover、单击触发交互；③ 别的应用全屏工作时宠物仍可点/可拖（#33281 场景）；④ 任务栏不被遮挡交互；⑤ 拖动流畅无抖动

**验收（自动化部分 ✅ 2026-09-12 真机）**：启动即 click-through；did-finish-load 重 apply 生效；真实/合成光标进入宠物 bodyRect → 日志翻 `interactive`，离开 → 翻回 `click-through`（两次受控验证）。决策矩阵 12 用例（fresh/stale 信号、轮询兜底、坐标映射、滞回进出、拖动保持）全绿。

**实施记录**：
- 状态翻转打了一行 log（`pointer-through: interactive/click-through`）——排查穿透问题的首要诊断线，保留。
- renderer 信号节流 50ms + snapshot 推送/pointerdown/pointerup 强制直发 + 1s keep-alive。
- preload 在 sandbox 下必须 CJS（Phase 0 已固），IPC payload 在 main 侧做形状校验（不可信输入）。

## Phase 4：DSH 状态桥（✅ 2026-09-12 完成；真 DSH 联测待用户跑 `dsh web` 复验）

- [x] `src/main/dsh-bridge/`：按 03 号文档实现——`frames.ts`（信封解包 + mux/host 帧解释，docs/03 §7 的 9 条转换落点）+ `backoff.ts`（官方退避参数）+ `ws-socket.ts`（ws 薄包装，JSON 文本帧/无 Origin/仅 ping）+ `dsh-client.ts`（describe 探活 HTTP 信封）+ `bridge.ts`（生命周期 FSM）；两条 WS（mux + host，**双流**）经 Phase 1 的 state-relay 接到 attachStateChannel
- [x] 连接生命周期：退避（500ms×2 至 10s 带抖动、3s 开流握手）、`ping()` 25s 心跳两拍无 pong 判死、重连后 subscribed 集对照清差集（基线封印窗口 1s）
- [x] 端口发现：`PETWEEN_DSH_PORT` 环境变量 → 默认 3080 → 探活 `POST /api/host.describe`（设置项入口 Phase 5 接）
- [x] 降级：DSH 不在时退避循环不产事件（宠物 idle 纯装饰）；状态经 `onStatus` 回调输出（Phase 5 托盘接）
- [x] 状态源：aggregate 模式（不装 CurrentSessionSource，petween §14.5 fallback 自动生效）
- [x] 单测：帧转换逐条对照 03 号文档（信封/解释/忽略集 14 用例）+ 退避参数边界 + FSM fixture 驱动（降级循环/双流接线/订阅差集/心跳判死/握手超时/close 清理 8 用例）

**验收（✅ 2026-09-12 假 DSH 真机端到端）**：起最小假 DSH（实现 describe + 双 WS 流规格帧）→ 桥经**真实 WebSocket/HTTP** 连接 → SSE 流完整走出 `turn-start → thinking → tool-start(command) → tool-end → success → idle`（每帧对应 docs/03 §2 转换正确；idle 时间戳走本机时钟验证第 7 条）；杀假 DSH → 探测退避 → 重启 → 自动重连 + 基线重放（快照保留 lastBySession 验证）。**真 DSH 联测（`dsh web` 在跑时思考→thinking、完成→success、DSH 重启→无残留）待用户复验。**

**实施记录**：
- 帧解释与 FSM 全部纯函数/注入式（socket/describe/时钟可换 fake），fake-timer 驱动 8 个 FSM 场景。
- 心跳判死阈值 `>=` 两倍间隔（两拍无 pong 即判，比 `>` 严格一拍对齐官方语义）。
- 重连差集在基线封印（1s settle）后计算——回环基线毫秒级到达，此窗口只封差集不阻塞事件。
- 临时假 DSH 脚本（`.fake-dsh.tmp.mjs`）验完即删，不入库；复验时可参考 docs/03 §2 帧格式重建。

## Phase 5：系统集成（✅ 2026-09-12 完成；开机自启重启系统生效待用户复验）

- [x] 单实例锁 + `second-instance` 唤起设置窗（✅ 真机验证：二次启动立即退出、首实例弹设置窗）
- [x] 托盘：打开设置 / 退出 / DSH 连接状态显示（bridge onStatus → 菜单重建）/ 开机自启勾选（**开/关用完全相同 path/args**，login-item.ts 显式空 args；dev 下禁用勾选防注册裸 electron.exe）；`resources/tray.png` 32x32 生成入库；Tray 实例模块级引用防 GC
- [x] settings 窗口 close→hide（`shouldHideOnClose` 谓词注入，托盘退出经 before-quit 翻转）；`window-all-closed` 不退出（空处理器）
- [x] `display-metrics-changed` / 分辨率变化重新铺满（Phase 2 已做：具名监听器 + closed 移除）
- [x] 「从 DSH 导入数据」菜单项：**自写 `legacy-import.ts`**（copy-if-absent：assets/assets.json/animations/pets，绝不覆盖已有；config 不动、导入后在编辑器里手选宠物预设）。原因：petween 的 `migrateLegacyHome` 目标目录存在即 skip——桌面版首启后 dataRoot 必然存在，该函数无法用于运行时导入（docs/02 §2 清单里它的适用场景是 DSH 侧目录改名）。确认对话框 + 结果对话框。

**验收（✅ 2026-09-12 真机，自动化部分）**：二次启动唤起设置窗 ✓；托盘图标存在（洋红圆点）+ DSH 状态行 ✓；进程清理干净（0 electron 残留）✓。**待用户复验**：开机自启勾选后重启系统生效（路径含空格场景——login-item.ts 用 Electron 44 的 CVE-2026-34768 修复后版本，引号处理由 API 保证）；托盘菜单各入口手工点一遍；「从 DSH 导入」真实数据跑一次（本机 `~/.dsh/petween` 有 Aug-28 数据可试）。

**实施记录**：
- 托盘模板纯函数化（`tray-menu.ts`，action id → handler 映射在 tray.ts），状态组合 2 用例；legacy-import 3 用例（copy/skip 边界 + canImport 判定）。
- 设置窗两种模式都直接 loadURL local-server（不是 vite 页面，天然同源，无需代理）。

## Phase 6：构建分发（✅ 2026-09-12 打包链落地并真机验证便携版；发布项待拍板）

- [x] electron-builder + NSIS（`electron-builder.yml`，docs/04 §5 配置）+ asar + files 白名单：`out/**` + `vendor/petween/lib/editor.js`（构建链先构建 submodule——`dist:win` 脚本一键串联）；排除 `node_modules/petween`（源码已打进 out/main，link: 依赖不能跟进整个 submodule）与 react/react-dom（仅构建期依赖）；`tray.png` 走 extraResources；同时产出 `dir` 便携版用于本地验证
- [x] `vendor/petween/lib/editor.js` 进包：**构建脚本先构建 submodule** 策略（产物不入库），`pnpm dist:win` = petween build → electron-vite build → electron-builder
- [ ] GitHub Releases + electron-updater（**待用户拍板 appId/发布仓库后启用**；更新前 flush 在途保存的注意项已在 docs/04 §5 记录）
- [x] README：安装说明 + **SmartScreen「更多信息→仍要运行」说明**（含 DSH 端口/环境变量说明、开发命令）
- [ ] Playwright `_electron.launch` 冒烟（**暂缓**：便携版真机冒烟已覆盖等价面——见下；补自动化冒烟记为后续增强）

**验收（✅ 2026-09-12 便携版真机）**：`dist/win-unpacked/Petween.exe` 直跑：随机端口 local-server 起服务（51401）、数据目录正确、穿透初始化（click-through×2 = init + did-finish-load 重 apply）、DSH 退避循环、**宠物从 asar 伺服的 overlay 页面正常渲染**（透明置顶窗 + 配置/资产 API + petween-assets 全链走打包产物）、托盘图标在位、无错误弹窗、进程退出干净。NSIS 安装器已产出（`dist/Petween Setup 0.1.0.exe`，~106MB）。**待用户复验**：干净机器/新用户目录安装→首跑全流程；卸载无残留启动项。已知小项：本机代理环境下 curl 直连 51401 挂起（Electron 窗内自取不受影响，发布前在新机器复测）。

**实施记录**：
- 打包产物体积：asar ~2MB + Electron 运行时 → 安装器 ~106MB（符合 docs/01 预估的 50-100MB 地板价上沿）。
- `main` 字段 = `out/main/index.js`（package.json 早已配置）；便携版日志直接走 stdout，排查方便。
- packaged userData 沿用 `petween-desktop`（package.json name），与 dev 一致——首装即空数据目录属预期（用户导入图片后才见宠物）。

## Phase 7：桌面设置窗口与可调穿透（✅ 2026-09-14 完成；用户 2026-09-14 确认单窗方案、连接器暂缓）

用户反馈驱动：桌面端需要自己的设置（Connect / 通用 / 穿透可调）；点击穿透体感从未成功（→ 已定位修复 flapping bug `aa263f3`：keep-alive 重申冻结的 hover 结论导致整窗抖动）；设置单窗 vs 双窗（→ 调研后拍板**单窗 + iframe 内嵌**）。

- [x] `desktop-settings.ts`：壳层设置存储（`userData/desktop-settings.json`，防抖持久化 + 变更订阅 + 严格归一化/夹取；**不碰 petween config**）
- [x] `desktop-routes.ts`：`/api/petween-desktop/*`（settings GET/PUT、status、autolaunch GET/PUT、fix-interaction、dsh-test 探活）——设置页唯一传输通道（无 IPC），dev 走 proxy / prod 同源同一份代码；与 `/api/petween` 命名空间按段边界不冲突
- [x] 设置页 `src/renderer/settings/`（第二个 vite 入口）：四分区左导航——**连接**（DSH 卡片：启停/端口/实时状态/测试按钮 + 未来连接器占位）、**宠物**（iframe 内嵌 `/petween-editor/`，保持挂载只切可见性防丢草稿；真实数据三栏布局验证过）、**交互**（模式三选 自动/始终穿透/始终可交互、命中外扩 0-24px、鼠标转发开关、自愈开关、救援热键开关、立即修复交互）、**通用**（开机自启镜像 + 版本/数据目录）
- [x] pointer-through 设置化：`PointerThroughRuntimeOptions` 实时热更（updateOptions 强制重下发让 forward 开关即时生效）；强制模式逃生舱；**自愈**（5s 周期重申 + render-process-gone/powerMonitor resume/显示器增删改/拖动结束后 re-issue——对应 electron#33281/#15376→PR#52633/#49982/#41501 家族）；救援热键 Ctrl+Alt+P 切互斥「交互锁定」（注册失败优雅降级——本机实测被占用，热键可配置列入后续）；`showInactive()` 替代 `show()`（#11049）
- [x] DSH 桥由设置驱动：启停即时生效（关=纯桌宠模式），端口下轮重连周期生效（`PETWEEN_DSH_PORT` 环境变量仍可覆盖）
- [x] 单测 +17（70 全绿）：设置存储归一化/持久化/订阅、路由全端点、强制模式与内边距、settings 页别名

**验收（✅ 2026-09-14 真机）**：设置页四分区渲染 ✓；iframe 内嵌编辑器在真实用户数据（deepseek 预设/1254×1254 图）下三栏呈现 ✓（elementFromPoint 证实导航不被遮挡）；模式切「始终穿透」→ 持久化 + 主进程日志实时重新应用 ✓；DSH 关→桥停（探测计数冻结）/开→新桥重启 ✓；二次启动唤起设置窗口显示连接分区 ✓；模式已还原 auto。

**调研沉淀（三个子智能体报告，2026-09-14）**：
- Electron 穿透坑位全景 + 设置项设计依据（见 pointer-through.ts 注释与上表；watchlist：PR#52631/#52633 合入 44.x 后复验）。
- 连接器路线图：Claude Code（hooks http handler，6/6 状态显式，**首选**）> opencode（SSE，状态枚举近 1:1）> Codex/Gemini/Cursor（command hooks）> Windsurf/Amp；架构=传输家族（本机 HTTP 监听 / SSE-WS 客户端 / 文件监听）+ NormalizedAgentEvent + per-session 状态机 + watchdog。**连接器实现按用户指示暂缓**。
- 编辑器可嵌入性：零 frame-busting/XFO/顶层假设，iframe ≥1001px 三栏；`PetweenCard` 不适合替代（跳转卡片）。

**遗留（后续增强清单追加）**：救援热键可配置（本机 Ctrl+Alt+P 被占用）；设置页「连接」分区的连接器卡片槽位已留；穿透调试可视化（显示命中矩形）；Playwright 设置页冒烟。

## 后续增强（MVP 后，按价值排序）

1. **连接器：Claude Code**（已调研 2026-09-14：hooks http handler 主动 POST 到本机端口，6/6 宠物状态显式覆盖，桥接成本最低）→ opencode（SSE，状态枚举近 1:1）→ Codex/Gemini/Cursor
2. petween 侧 P0-P2 补丁回流（`dependencies` 声明、`./host` 装配桶 exports——见 02 号文档 §6；现有三仓库源码消费，P0 越发值得）
3. 「跟随 DSH 当前会话」状态源（替代 aggregate）
4. 救援热键可配置（现为固定候选链 P/I/U）
5. 穿透调试可视化（命中矩形叠加显示）
6. 多显示器每屏一窗
7. Playwright 设置页/打包版冒烟自动化
8. 动态 `setShape` 备用穿透方案（疑难机器）
9. ~~petween-physics 移植~~（✅ Phase 8 完成，双宿主形态）

## Phase 8：伴生插件宿主 + physics-desktop（✅ 2026-09-16 完成；用户真机确认「基本没问题」）

> 背景：用户提出桌面端插件化问题。结论（2026-09-16 多轮确认）：**不做 DSH 式插件平台，做最小 companion 宿主**——插件化已发生在 petween 层（`petween/client` 服务契约 + 伴生模式），桌面侧只需 hosting 该契约；连接器（main，事件源）与伴生（overlay 渲染进程，控制面）两类插件分开抽象。外部进程插件/用户态安装留待触发信号（≥2 第三方作者 / 需运行时装卸 / 连接器生态化）。

### 已定决策

1. v1 形态 = **编译期注册的进程内 companion 模块**（overlay renderer import，设置启停，崩溃隔离）；物理这类 60fps 位置控制不走 IPC。
2. **双宿主约定**：插件仓库自己导出 `./desktop` 入口（与 DSH 入口共享本体代码）；三纪律 = 服务获取收单缝（`petweenClientServiceOf` 模式）、HTTP 全根相对、行为类与 cordis 入口分离。petween-physics 已满足全部三条（已核实：host 半 `configPath` 可注入、路由同形 RoutesHost、提取器 4 行）。
3. 仓库纪律：`petween-physics` 作为第二个 git submodule（github.com/Traveritas/petween-physics），改动回流上游，桌面只装配。
4. 配置归属：companion 自身的持久配置走它自己的 host store（physics 有现成的 config API）；desktop-settings 只存**启停**。最薄。

### 工作分解（A/B 可并行）

**8A companion 宿主机制（✅）**
- [x] `src/renderer/companions/registry.ts`：`DesktopCompanion` 接口（`{ id, displayName, description?, SettingsCard?, init(ctx): dispose? }`，ctx = petween 单例）+ 注册表 + try/catch 崩溃隔离
- [x] desktop-settings 加 `companions: { enabled: Record<string, boolean> }`（缺省=启用）
- [x] 设置页「插件」分区：toggle + SettingsCard 托管
- [x] overlay 入口按设置挂载（3s 轮询差量重挂载）；单测 5 用例

**8B petween-physics 双宿主化（✅ 上游 `0bbc914` 已推送）**
- [x] `src/desktop/index.ts`：`createPhysicsDesktopCompanion()`（ThrowController + §12 拉推 + visibility settle；viewport = overlay 窗口）
- [x] exports `"./desktop"` + tsdown `lib/desktop.js`（ESM、react external）
- [x] README「Desktop 宿主形态」：三条纪律 + 契约镜像说明

**8C physics-desktop 装配（✅）**
- [x] submodule `vendor/petween-physics` 锁 `0bbc914`（submodule 内无需 install/build——源码消费，其依赖由根 node_modules 满足）
- [x] link: 依赖 + vite(main/renderer)/tsconfig/vitest 四处别名 + `/api/petween-physics` 代理
- [x] local-server 暴露 petween companion host service（`createPetweenHostService`）；`physics-assembly.ts`（config 存储注入 userData、路由挂共享表、默认弹跳动画注册）
- [x] 注册 physics companion（SettingsCard = PhysicsCard）；装配级单测 2 用例

**8D 真机验收（✅ 用户 2026-09-16 确认）**
- [x] 插件分区 + PhysicsCard（22 控件）渲染 ✓；physics config API 真机伺服 ✓
- [x] 全量回归：壳层 78 用例 + physics 上游 166 用例 + petween 基线 1044 用例全绿
- [ ] 投掷手感参数微调（用户日常使用中按需调 PhysicsCard 参数）

**实施记录（含一次事故）**：
- **2026-09-16 鼠标卡死事故**：调试期间把模式切到 always-interactive 且被持久化 → 整屏窗吃掉系统所有鼠标点击（键盘不受影响，overlay focusable:false）；救援热键 Ctrl+Alt+P 被占用注册失败 → 无逃生口。三层防线已落地：持久化加载降级 auto / 会话内 60s 自动回落 / 热键链式注册（P→I→U）。
- **坐标空间教训**：本机 2560×1600@100%，overlay CSS 视口 = 2560×1600；computer-use 截图 raster 是半采样（1280×800）——换算 raster×2=CSS。给视觉模型喂先验坐标会得到顺从性误判（报错误位置"确认存在"），验收要以 config overlay 值/bodyRect 等数据源为准。
- **排查顺带证实**：穿透三通道（转发 hit-test/光标轮询/滞回）在真实数据下判定全部正确。
- **待办**：`dist:win` 前需在 electron-builder.yml files 加 `!node_modules/petween-physics`（防止 link 跟进 submodule）；dev 长会话中 main 热重启监视器偶发失灵（重启 dev 即恢复，低优先级记录）。

## 待用户拍板项

- [ ] GitHub 仓库名 / appId（`com.traveritas.petween`?）与 publish 目标仓库
- [ ] 数据目录策略确认：独立 `userData/petween-home/` + 一次性从 `~/.dsh/petween` 导入（02 号文档 §4 的推荐）
- [ ] 是否需要 macOS 支持（穿透/托盘 API 有平台差异，MVP 只验 Windows）
