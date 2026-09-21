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

**验收（✅ 2026-09-12 假 DSH 真机端到端；✅ 2026-09-16 用户真 DSH 联测通过「测试成功，基本没问题」）**：起最小假 DSH（实现 describe + 双 WS 流规格帧）→ 桥经**真实 WebSocket/HTTP** 连接 → SSE 流完整走出 `turn-start → thinking → tool-start(command) → tool-end → success → idle`（每帧对应 docs/03 §2 转换正确；idle 时间戳走本机时钟验证第 7 条）；杀假 DSH → 探测退避 → 重启 → 自动重连 + 基线重放（快照保留 lastBySession 验证）。真 DSH 场景（`dsh web` + 桌面版并行）用户复验通过。

**实施记录**：
- 帧解释与 FSM 全部纯函数/注入式（socket/describe/时钟可换 fake），fake-timer 驱动 8 个 FSM 场景。
- 心跳判死阈值 `>=` 两倍间隔（两拍无 pong 即判，比 `>` 严格一拍对齐官方语义）。
- 重连差集在基线封印（1s settle）后计算——回环基线毫秒级到达，此窗口只封差集不阻塞事件。
- 临时假 DSH 脚本（`.fake-dsh.tmp.mjs`）验完即删，不入库；复验时可参考 docs/03 §2 帧格式重建。

## Phase 5：系统集成（✅ 2026-09-12 完成；开机自启重启系统生效待用户复验）

- [x] 单实例锁 + `second-instance` 唤起设置窗（✅ 真机验证：二次启动立即退出、首实例弹设置窗）
- [x] 托盘：打开设置 / 退出 / DSH 连接状态显示（bridge onStatus → 菜单重建）/ 开机自启勾选〔Phase 8 后设置页另有镜像开关〕（**开/关用完全相同 path/args**，login-item.ts 显式空 args；dev 下禁用勾选防注册裸 electron.exe）；`resources/tray.png` 32x32 生成入库；Tray 实例模块级引用防 GC
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

用户反馈驱动：桌面端需要自己的设置（Connect / 通用 / 穿透可调）；点击穿透体感从未成功（→ 已定位修复 flapping bug `726209e`：keep-alive 重申冻结的 hover 结论导致整窗抖动）；设置单窗 vs 双窗（→ 调研后拍板**单窗 + iframe 内嵌**）。

- [x] `desktop-settings.ts`：壳层设置存储（`userData/desktop-settings.json`，防抖持久化 + 变更订阅 + 严格归一化/夹取；**不碰 petween config**）
- [x] `desktop-routes.ts`：`/api/petween-desktop/*`（settings GET/PUT、status、autolaunch GET/PUT、open-animator（Phase 11 加入）、fix-interaction、dsh-test 探活）——设置页唯一传输通道（无 IPC），dev 走 proxy / prod 同源同一份代码；与 `/api/petween` 命名空间按段边界不冲突
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

1. **连接器**：~~zcode~~（✅ 2026-09-18 Phase 9 落地，见下文与 docs/06；架构与传输家族就此定型——curl cfg 端口发现 + 合并安装 + watchdog 模板）→ ~~Claude Code~~（✅ 2026-09-20 Phase 15 落地，docs/07）→ ~~Codex~~（✅ 2026-09-20 Phase 16 落地，docs/08）→ opencode（SSE，状态枚举近 1:1）→ Gemini/Cursor
2. petween 侧 P0-P2 补丁回流（`dependencies` 声明、`./host` 装配桶 exports——见 02 号文档 §6；现有三仓库源码消费，P0 越发值得）
3. 「跟随 DSH 当前会话」状态源（替代 aggregate）
4. 救援热键可配置（现为固定候选链 P/I/U）
5. 穿透调试可视化（命中矩形叠加显示）
6. 多显示器每屏一窗
7. Playwright 设置页/打包版冒烟自动化
8. 动态 `setShape` 备用穿透方案（疑难机器）
9. ~~petween-physics 移植~~（✅ Phase 8 完成，双宿主形态）
10. **独立编辑器分发**（2026-09-17 评估后拍板：暂不做，触发式启动）——正确形态是上游 petween 仓出 `editor-server` CLI/Web 入口（host 半纯 Node 已验证 + editor.js 自包含，~100 行装配 + npm/单 exe 分发），DSH/桌面/独立三宿主共用同一编辑器；**不拆仓/不拆 DSH 插件**（与 2026-09-12 单仓决策冲突、编辑器与 client 半共享类型/store）。触发信号：出现 ≥1 个第三方宠物/动画创作者，或宠物包生态开始对外分发。数据可移植性已由宠物包/动画包解决，非触发场景无需求。

## Phase 8：伴生插件宿主 + physics-desktop（✅ 2026-09-16 完成；用户真机确认「基本没问题」）

> 背景：用户提出桌面端插件化问题。结论（2026-09-16 多轮确认）：**不做 DSH 式插件平台，做最小 companion 宿主**——插件化已发生在 petween 层（`petween/client` 服务契约 + 伴生模式），桌面侧只需 hosting 该契约；连接器（main，事件源）与伴生（overlay 渲染进程，控制面）两类插件分开抽象。外部进程插件/用户态安装留待触发信号（≥2 第三方作者 / 需运行时装卸 / 连接器生态化）。

### 已定决策

1. v1 形态 = **编译期注册的进程内 companion 模块**（overlay renderer import，设置启停，崩溃隔离）；物理这类 60fps 位置控制不走 IPC。
2. **双宿主约定**：插件仓库自己导出 `./desktop` 入口（与 DSH 入口共享本体代码）；三纪律 = 服务获取收单缝（`petweenClientServiceOf` 模式）、HTTP 全根相对、行为类与 cordis 入口分离。petween-physics 已满足全部三条（已核实：host 半 `configPath` 可注入、路由同形 RoutesHost、提取器 4 行）。
3. 仓库纪律：`petween-physics` 作为第二个 git submodule（github.com/Traveritas/petween-physics），改动回流上游，桌面只装配。
4. 配置归属：companion 自身的持久配置走它自己的 host store（physics 有现成的 config API）；desktop-settings 只存**启停**。最薄。

### 工作分解（A/B 可并行）

**8A companion 宿主机制（✅）**
- [x] `src/renderer/companions/registry.ts`：`DesktopCompanion` 接口（`{ id, displayName, description?, SettingsCard?, init(ctx): dispose? }`，ctx = petween 单例）+ 注册表 + try/catch 崩溃隔离。**Phase 18 起 SettingsCard 受控化（`{value, onChange}` 纯控制、卡内零网络）+ 可选 `configStore`，见 Phase 18 节与 registry.ts 头注释**
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
- [x] 全量回归：壳层用例（Phase 8 时 78，里程碑评审后 89）+ physics 上游 166 用例 + petween 基线 1044 用例全绿
- [ ] 投掷手感参数微调（用户日常使用中按需调 PhysicsCard 参数）

**实施记录（含一次事故）**：
- **2026-09-16 鼠标卡死事故**：调试期间把模式切到 always-interactive 且被持久化 → 整屏窗吃掉系统所有鼠标点击（键盘不受影响，overlay focusable:false）；救援热键 Ctrl+Alt+P 被占用注册失败 → 无逃生口。**用户拍板：该模式整体移除**（与救援热键的瞬时锁定功能重叠且是唯一能卡死鼠标的路径）；救援热键改为链式注册（Ctrl+Alt+P→I→U）。任何残留的 always-interactive 设置值归一化为 auto。
- **坐标空间教训**：以本机为例（2560×1600@100%）：overlay CSS 视口即物理分辨率，而自动化截图 raster 可能是半采样（如 1280×800）——换算 raster×2=CSS。给视觉模型喂先验坐标会得到顺从性误判（报错误位置"确认存在"），验收要以 config overlay 值/bodyRect 等数据源为准。
- **排查顺带证实**：穿透三通道（转发 hit-test/光标轮询/滞回）在真实数据下判定全部正确。
- ~~**待办**：`dist:win` 前需在 electron-builder.yml files 加 `!node_modules/petween-physics`~~（✅ 同日 v0.1.0 评审已修）；dev 长会话中 main 热重启监视器偶发失灵（重启 dev 即恢复，低优先级记录）。


## v0.1.0 里程碑评审（2026-09-16，五路子智能体综合评审）

评审维度：主进程架构 / 渲染层 / 测试覆盖 / 文档一致性 / 安全与打包。**结论：零 P0；4 个 P1 与一批 P2 已当场修复；其余入后续 backlog。** 修复后全量回归 89 用例全绿。

### 已修复（随本里程碑提交）

- **P1 打包**：electron-builder files 补 `!node_modules/petween-physics`（防 link 跟进 submodule）。
- **P1 设置持久化**：desktop-settings 写链化（消除 debounce/flush 并发写竞态）+ `flushSync()`（quit 处理器同步写，防抖窗口内的最后修改不再丢失）。
- **P1 启动失败无头僵尸**：bootstrap().catch → showErrorBox + quit。
- **P1 设置窗 minWidth**：1120 → 1210（1001px iframe 三栏 + 191px 导航 + 边框的算术此前不成立）。
- **P1 设置 PUT 竞态**：渲染端 seq 守卫（过期响应不回写）+ 失败重入队重试（≤3 次）；GET 失败退避重试（≤5 次）。
- **P2 服务端**：server.listen 错误拒绝；路由分发 500 包装；desktop-routes 跨源写栅栏（对齐 petween 上游 `rejectsCrossOriginWrite`）+ res error sink + sendJson destroyed 守卫 + 超载响应先答后断。
- **P2 渲染端**：loadURL 失败日志；preload 缺失守卫（不再静默永久穿透）；modePicker 双列；PhysicsCard 暗色令牌注入（`--dsh-alias-*` on .companionCard，零上游改动）。
- **测试盲区补齐**：pointer-through 胶水（vi.mock electron，8 用例：IPC 净化/发送者守卫/drag 重锚/锁定/forward 传递/自愈/销毁）；dsh-client 信封契约（假 http 服务器）；flushSync 退出窗口竞态。

### 评审确认的坚实面（记录在案）

桥 FSM 的 epoch 纪律、穿透纯逻辑/监听器卫生、local-server 装配保真度、overlay-static 双层路径穿越防护、loopback-only 姿态（无出网）、单 IPC 通道 + 发送者/形状双验证、双窗口 sandbox/contextIsolation、vendor 侧输入限额体系。

### Backlog（按价值排序，未修项）

1. DSH 端口热改即时生效（现为下一重连周期；桥跟踪已连端口即可 stop+start）。
2. 测试：真实 relay+attachStateChannel+SSE 端到端；ws-socket 真适配器契约；overlay companion 重挂载循环。
3. 设置页 status 轮询可见性门控；autolaunch PUT 失败重同步；overlay sync epoch 守卫。
4. CSP dev/prod 差异化（prod 去 17777 字面量）；可选 Host 头检查 + proxy changeOrigin（DNS rebinding 加固）。
5. bridge 循环崩溃自动重入退避；救援热键策略抽纯模块；dsh-bridge maxPayload/mounted 上限（恶意 DSH 硬化）。
6. 上游 backlog：petween 编辑器页 CSP（上游补丁清单）。
7. dev 长会话 main 热重启监视器偶发失灵（重启 dev 恢复）。

### 信任边界（安全评审结论记录）

本地 loopback API 无鉴权是**接受的设计边界**：任意本地进程本就能直接读写同用户权限的文件与注册表（含同一 HKCU Run 键），API 未提供越权能力；自启开关只能切换 Petween 自身（path/args 硬编码）。浏览器页攻击面已由跨源写栅栏 + 无 CORS 头 + 随机端口覆盖。若未来连接器引入真正特权动作，再考虑 token 化。

## 2026-09-18 本地发布构建 + prod 双 React P0 修复

用户要求先不接 electron-updater/publish，出一个能跑的本地构建自用。构建过程发现并修复一个 **P0（prod 独有）**：

### P0：prod 渲染包双 React，overlay 从未挂载

- **现象**：打包版 overlay 窗口 `#root` 恒空、零 `/api/petween/config` 轮询、控制台 `TypeError: Cannot read properties of null (reading 'useState')`（`react_production_min.useState` ← PetOverlay）。设置页碰巧免疫（壳层自有 react 单副本）。
- **根因**：`vendor/petween` 是独立 pnpm 项目（自己的 node_modules），其源码的裸 `react` import 在 **rollup 构建下**解析到 submodule 的第二份物理 react；壳层入口解析根 node_modules 的 react + react-dom → 产物含两份 React，hooks 调度器分裂。dev 服务器按优化根图解析，两路合一，所以 Phase 2~7 真机验收全部正常、打包后才炸。
- **修复**：`electron.vite.config.ts` renderer `resolve.dedupe: ['react', 'react-dom']`，强制统一从本仓库根解析。修复后 `react_production_min` 标记只在共享 chunk 出现一次，overlay 入口 chunk 由 184KB 缩至 172KB。
- **验证链**（全部在打包 exe 上）：CDP（`--remote-debugging-port`）确认 root 挂载、精灵图解码（natural 1254×1254）、config 轮询存活、API 移动位置后 `inset` 跟随；**DPI-aware 像素差分**确认屏幕级可见（`enabled:false` 开关使精灵区域精确消失，21k 像素簇）；二次实例唤起设置窗五分区 + 编辑器 iframe 正常。typecheck + 89 用例全绿。

### 教训（构建验证方法论）

1. **prod 渲染产物必须单独验证挂载**——dev 正常不证明打包正常（依赖解析路径不同）。后续增强清单的「Playwright 冒烟」正是为此。
2. GDI `CopyFromScreen` 截图在 DPI-unaware 进程里拿到的是缩放副本，且**抓不到 layered 透明窗内容**——对 overlay 做像素验证必须先 `SetProcessDPIAware()`。
3. electron-builder 下载（Electron zip 等）不走系统代理，需 `HTTPS_PROXY=http://<本地代理地址> pnpm run dist:win`（本机代理环境）。

### 产物

- `dist/Petween Setup 0.1.0.exe`（NSIS 安装器，未签名 → SmartScreen「更多信息→仍要运行」）
- `dist/win-unpacked/Petween.exe`（便携版）
- 无 updater/publish（按用户要求）；数据目录与 dev 共享 `userData/petween-home/`，dev 与打包版受单实例锁互斥。

## 2026-09-18（晚）：Phase 9 zcode 连接器（✅ 真机联测通过，用户确认「功能正常」；同晚追加两项反馈处理）

后续增强清单第 1 项的 zcode 分支落地（规格 = docs/06；与 2026-09-14 调研的 Claude Code 首选方案同构，zcode hooks 即 Claude Code 兼容面）。复用 `StateRelay` 缝 + 伪造 DSH 信封，**petween 零改动**，与 DSH 桥按 sessionId 天然并存。

### Spike 结论（2026-09-18，沙箱实测）

- zcode hooks 机制存在且按 turn 跑相位（日志 `turn.phase.*: user_prompt_hooks/session_start_hooks`，子会话也跑）；**hooks 配置客户端启动时读取**——运行中的客户端对新写入的用户级/工作区级配置均不拾取（本 turn 与新 spawn 子会话都验证不触发）→ 安装后必须重启 zcode 客户端。
- curl+cfg 链路人工验证通过：System32 curl 8.21 `--config` + `--data-urlencode`，热路径 ~50ms/次；无 Origin 头（跨源栅栏放行）。死端口 1s 超时是沙箱吞 RST 的假象，真机预计瞬时拒绝。
- 无 zcode CLI 可调用（`~/.zcode` 全是配置/状态目录）→ 无法自动开新会话联测。

### 实现清单（✅ 全部完成，126 用例全绿）

- [x] `src/main/connectors/zcode-connector.ts`：8 种 hook 事件 → DSH 信封映射 + per-session watchdog（stop 后 60s 合成 idle、permission 搁置 10min 解卡、30min 静默 disposed）
- [x] `src/main/connectors/zcode-hooks.ts`：curl cfg 渲染/每 boot 重写（端口发现）+ 安装/卸载合并写入 `~/.zcode/cli/config.json`（foreign 条目保留、损坏文件不覆盖、重装幂等）
- [x] `src/main/connectors/zcode-routes.ts`：事件 sink（204 恒快）+ status + install/uninstall，跨源栅栏同款
- [x] 设置存储 `connectors.zcode.enabled` + 设置页「连接」分区 zcode 卡片（替换占位卡：启停/安装移除/实时状态）
- [x] 端到端冒烟测试（真实 curl 进程 → cfg → 路由 → 状态机 → `/state` 断言全序列）；PreToolUse 三 matcher 分类（edit/command/other，other 用负向前瞻——裸 test 假设，docs/06 §7.1 观察项）
- [x] 版本 0.2.0，`dist-0.2.0/` 产出 NSIS + 便携版（旧 `dist/` 被运行中实例锁定，换目录打包）
- [x] 真实 hooks 已安装到 `~/.zcode/cli/config.json`（指向 `%APPDATA%/petween-desktop/zcode-hooks/`）

### 待用户真机联测（✅ 2026-09-18 用户完成并确认「功能正常」）

1. ~~退出当前 Petween（托盘→退出），跑 `dist-0.2.0/win-unpacked/Petween.exe`~~ ✓
2. ~~重启 zcode 客户端看联动~~ ✓

### 用户反馈追加（同晚处理，v0.2.1）

1. **「只跟随最近交互的会话」模式**（多活跃会话时后台会话不干扰表情）：zcode 无窗口焦点信号，焦点代理 = 用户主动事件（`user-prompt-submit`/`session-start`）；后台会话记账不发射，焦点切换时旧目标补 idle（rank 0 退休）+ 新目标重放最后视觉。设置 `connectors.zcode.followLatestUser`（默认关）+ zcode 卡片开关；顺带修复 connectors 段 patch 只做一层合并会丢兄弟字段的隐患。详见 docs/06 §3.1。
2. **思考/工作不换图**（DSH 端也出现过）：不是连接器 bug——petween §15.2 设计默认 `advanced.changePoseWithinActive=false`（active 内换 mode 只刷 ambient 不换 pose）。已通过 config API 把用户活配置翻转为 true（热生效，revision 67）；编辑器「高级与互动→活跃状态内切换姿势」即此开关。**上游默认值已拍板改 true**（2026-09-18 用户：「改一下，默认 true 吧」）——petween `6ed667e`（默认翻转 + 规格 §15.2 重写 + 6 处默认依赖测试更新，1044 全绿），本仓库 bump 指针；显式存过 false 的旧配置不受影响，DSH 端字段缺失的配置在下次加载时自动吃新默认。

### 已知边界（docs/06 §7）

error 表情不可达（zcode 无 turn 级失败信号，Stop 一律映射 success）；应用未运行时每次工具调用在 zcode 日志留一条 curl failed 记录（不阻塞，exit≠2）；matcher 锚定语义与 Stop-错误回合行为待真机确认。

## Phase 10：统计泡泡 HUD（思考用时 / 编辑行数）（2026-09-18 代码完成；✅ 真机验收通过）

用户需求：文件写入弹「行数泡泡」（写入过程实时累加，完成后淡出）；思考弹「用时泡泡」（计时实时跳动，思考结束淡出）；样式与动画可扩展；先单会话，多会话排布与完成提醒后置。对话泡泡（带模型回复文本）**拍板为独立插件**——数据通道不同（hooks 拿不到回复文本，可靠来源只有 transcript 尾读）、生命周期不同；共享本次做的 BubbleHost 基础设施。

### 设计定案（评估轮拍板）

1. **数据走旁路不走状态信封**：连接器侧共享 stats 账本（`recordState`/`recordEdit` 两类规范化事实），HUD 轮询 `GET /api/petween-desktop/stats?since=<seq>`；petween 依旧零改动。账本连接器无关——Claude Code 连接器平移、DSH 桥后续从 `tool/call` arguments 喂同一账本。
2. **hook stdin 转发**：args 改 `--data-binary @-`，端点双格式解析（旧 urlencoded 兼容）。stdin JSON 双命名（camel+snake）spike 实证（docs/06 §8.1），PreToolUse 即带 `toolInput`（行数写入开始时可算），`turnId`/zcode `timestamp` 白捡。
3. **翻译层不设开关**：语义无偏好空间，且开关绑定 hook 注册形态（翻转=重装+重启）；hud 关闭靠 companion 开关，账本常驻（每事件毫秒级 + 每会话几十字节）。
4. **隐私不变量**：编辑内容在 HTTP 边界归约为行数，账本只存整数与 id。

### 实现

- main：`line-count.ts`（LCS 行 diff/补丁/多编辑，1M cell 兜底）、`stats-ledger.ts`（思考区间累加——waiting 打断不计、行数总计、256 容量 seq 环、焦点=显式 focus>最近活跃）、`stats-routes.ts`；连接器在 **follow 门控之前**记账（后台会话照常记账不发射）、focus 随发射会话、watchdog dispose 同步清账本行；hook args/端点双格式（docs/06 §8）。
- renderer：`companions/bubbles/`（BubbleHost——宠物 bodyRect 上方堆叠列、满则下方翻转+视口钳制、pointer-events:none 不碰穿透；样式注册表内置玻璃/终端/浅色三种，`registerBubbleStyle` 可扩展；动画预设弹出/升起/淡入/坠落四种）+ `companions/stats-hud/`（`hud-logic.ts` 纯 reducer：思考 1.5s 阈值防闪、编辑按 working 片段聚泡实时累加、离场 hold 后淡出、20s 硬上限、焦点切换立即隐藏；companion 轮询 stats 400ms/设置 3s，计时本地 250ms 跳动）。
- 设置：`companions.options['stats-hud']`（样式/动画/阈值，per-companion options 包合并不丢兄弟插件）；设置卡在「插件」分区。

### 验收

- [x] 单测 186 用例全绿（line-count/stats-ledger/stats-routes/端点载荷/连接器记账接线/hud-logic 全覆盖）+ typecheck
- [x] 真机：设置→连接→zcode「重装 hooks」→重启 zcode 客户端→ 跑编辑任务观察泡泡（✅ 经 v0.2.5~v0.3.15 十余轮真机反馈迭代确认，2026-09-20 用户确认泡泡线含皮肤批次全部正常）
- [x] 旧格式 hooks（未重装）期间一切照旧（宠物联动不断，只是无泡泡——过渡期实测如此）

### 后置项（重开触发器）

多会话泡泡动态排布（多列/避让策略）、完成提醒泡泡、对话泡泡（独立 companion，复用 BubbleHost；数据走 transcript 尾读）、里程碑触发宠物本体动画（`playAnimation` 接口已通）。

### 真机反馈追加（2026-09-19，v0.2.5）

用户确认写入泡泡正常显示。两项反馈落地：

1. **思考计时整秒显示**（去掉小数位，向下取整，v0.2.3）。
2. **入场/出场动画拆分为独立选项**（v0.2.5）：原打包预设（弹出→淡出、升起→沉落）改为两个注册表——入场 弹出/升起/淡入/坠落 × 出场 淡出/沉落/缩小，共 12 种组合，设置卡两个下拉；宿主 close 时先摘入场类再加出场类（不依赖 CSS 级联顺序）；旧 `animationId` 存量配置按 LEGACY_BUNDLED_EXITS 映射迁移，外观不变。
3. **「随风」出场 + 「飘落」入场**（v0.2.6）：飘摇上升/飘落（横向摆动 + 微旋转），随风出场 950ms 慢淡出；为此给出场动画加 `durationMs` 字段（宿主按动画自带时长移除元素，原先统一 450ms 会掐断慢动画）。入场 5 × 出场 4 = 20 种组合。随风/飘落的摆动 v0.2.7 重制：上升/淡出走 transform 单一缓动曲线，横摆拆到独立 rotate 属性按半周期 ease-in-out 摆荡（钟摆式，消除了同属性多路标逐段缓动的顿挫）。

## Phase 10 第二批：泡泡线四件套（2026-09-19 代码完成；✅ 2026-09-20 真机验收通过）

用户拍板「继续做泡泡线」，四项一次落地（v0.3.0，224 用例全绿，+22）：

1. **多会话泡泡排布**：BubbleHost 重构为按会话分列——焦点会话列正对宠物上方，其余按活跃度左右交替侧列（槽位分配抽成纯函数 assignColumnSlots 可测；每列容量 3、总量 9、列宽步距随宠物宽度）；`multiSession` 默认开，关掉恢复 v1 只看焦点会话；会话从快照消失（watchdog dispose）自动收泡。BubbleHost 改为共享单例（refcount），后续泡泡类 companion 共用一套坐标系。

2. **完成提醒泡泡（turn summary）**：账本新增回合追踪——user-prompt-submit 开回合（记基线），stop 关回合并发射 turn-summary 事件（思考/行数/编辑次数差值 + 墙钟时长，turnId 透传）；HUD 弹「完成 · 思考 X · +A −R · 时长」泡泡，停 4s 淡出。`turnSummary` 开关默认开。

3. **对话泡泡（回复摘要）**：数据源实证为 zcode 持久化的模型 I/O 流（~/.zcode/cli/rollout/model-io-<sessionId>.jsonl，AI-SDK 形状；hook 的临时 transcript 用后即删不可用）。注意单行内嵌完整请求上下文（长会话 >1MB/行，本机实测 10MB 文件）——固定尾窗必漏，最终实现为流式前扫 + 子串预过滤（只对含 "stop" 的行 JSON.parse）。turnId 匹配 + 重试三次容忍 rollout 写入滞后；markdown 剥离 + 160 字截断在 main 边界完成；`GET /api/petween-desktop/dialogue?session=` 按需读、零持久化——这是全链路唯一内容级通道（用户拍板过隐私面）。停 7s 淡出，`dialogue` 开关默认开。

4. **里程碑宠物动画**：编辑片段内累计新增行每跨 N 行（设置可调，0=关）触发宠物本体动画（默认 builtin:click-pop，可配 id），每会话 10s 节流。

### 验收（✅ 2026-09-20 用户确认）

- [x] 多窗口并开：各会话独立列、焦点切换列重排、后台会话照常弹泡（经 v0.3.1~v0.3.12 反馈迭代实机验证）
- [x] 回合结束：完成摘要泡泡 + 回复摘要泡泡（文本干净无 markdown 符号）
- [x] 里程碑动画触发（设置里把 N 调小如 50 便于观察）
- [x] 泡泡皮肤四批（玻璃/终端/浅色 + 漫画/便签/霓虹/墨金）全部正常（2026-09-20）

### 真机反馈追加（2026-09-19，v0.3.1）

四项体验修正：

1. **位置渐变**：泡泡 left/top 加 260ms 过渡（重排/列切换/翻转不再瞬移）；首次定位免过渡（不出现从 (0,0) 飞入）。
2. **列间距收紧**：stride 从 max(宠物宽,160)+48 收到 宠物宽/2+110（下限 150）——侧列贴近宠物，不再甩到远处。
3. **回复泡泡独立**：固定宠物左侧（右缘贴宠物左缘、垂直居中，独立堆叠容量 2），专属样式配置（replyStyleId，设置卡「回复样式」），内容裁剪为最多 3 行省略（-webkit-line-clamp，配合 main 侧 160 字截断双保险）。
4. **完成泡泡独立**：固定宠物下侧（水平居中，独立堆叠容量 2），专属样式配置（turnStyleId）。

布局模型从「纯分列」升级为三区域：column（统计泡泡按会话分列于宠物上方/侧翼）+ left（回复）+ below（完成），互不推挤。

5. **间距真凶（CDP 实测定位，v0.3.2；v0.3.3 重定为用户规格）**：宠物靠屏幕右缘时，右侧列的理论中心（2086）超出视口被钳到 2002，泡泡直接压在宠物身上——「间距不对劲」的真身。修复：assignColumnSlots 升级为 room-aware（左右按剩余空间贪心分配，宠物靠边时所有侧列自动转向内侧），无 room 信息时保留经典交替。合成三会话场景 CDP 复测：列中心等距排开、petOverlaps=0。

6. **列布局重定为用户规格（v0.3.3）**：不再以步距+宠物宽分列——所有列按**边框最近距离**留固定间隙（默认 24px，设置卡「列间距」可调），整组列**按宠物居中**打包（packColumnBand 纯函数），超出视口时整体内移优先保持在界内（组比视口还宽则左锚）。槽位只决定组内排序（焦点列居中）。CDP 复测：相邻列边框间隙精确 24px、allInBounds、宠物靠右缘时整组内移。注：诊断会话自身的 hooks 也在发事件（自指噪音），测量时要意识到这一点。

### 真机反馈追加（2026-09-19，v0.3.4）

**四类泡泡全维度独立配置**（用户拍板）：思考/编辑/回复/完成各自独立的样式、入场动画、出场动画、停留时长。配置结构从扁平键改为 types 分组（migrateTypeConfigs 迁移旧键且外观不变——styleId→思考+编辑、replyStyleId/turnStyleId→各自类型、全局动画对→全部类型、thinkingHoldMs/editHoldMs→对应 hold，显式 types 优先）。设置卡改为每类型一行（样式/入场/出场/停留四控件）；思考/编辑的 hold=完成后停留，回复/完成的 hold=显示总时长。231 用例全绿（+3 迁移测试）。

### 真机反馈追加（2026-09-19，v0.3.5：思考/编辑泡泡消失回归修复）

用户报「泡泡明显变少」。根因是 v0.3.4 spawnWith 重构把类型 holdMs 错用到**弹出时自动关闭**——思考泡泡出生 0.9s 即死（思考未结束也不复活，直到下回合）、编辑泡泡出生 1.5s 即死（同片段后续写入不可见）；而 thinking/edit 的生命周期本由 hide 命令驱动，holdMs 语义是「完成后停留」。修复：spawnWith 的自动关闭改为显式参数，仅 turn/reply（无命令驱动的类型）传入。CDP 决定性验证：三会话思考泡泡 5.2s 时全部存活且计时递增（修复前会全部死于 spawn+0.9s）、编辑泡泡跨两次写入存活累加。

### 真机反馈追加（2026-09-19，v0.3.6：完成泡泡不退场修复）

v0.3.5 修复时给 turn 调用点补 autoCloseMs 的字符串替换因缩进不匹配**静默未生效**（可选参数 + tsc 无法拦截）。教训落地：spawnWith 改为布尔 autoClose 标志（时长在函数内部从 cfg.holdMs 取，调用点不再复制值）；CDP 验证完成泡泡 4s 持续 + 淡出后离场（t=6.5s 全清）。

### 真机反馈追加（2026-09-19，v0.3.7：回复/完成泡泡按内容优化形状）

宿主出生时挂 pt-bubble--kind-<类型> 类（泡泡类型终身不变），三套内置皮肤按类型精修：玻璃的回复从 999px 药丸改 14px 卡片 + 段落行距 1.55 + 左对齐 + 标签升为块级题注；完成 16px 卡片圆角；终端/浅色同模式（圆角/内距/行距）。CDP computed-style 验证：回复 radius 14px/padding 10px 14px/line-height 20px/label block/clamp 3；完成 radius 16px。另发现：zcode rollout 文件会发生整体重置（疑似上下文压缩触发，本机 2026-09-19 21:05 实测 10.7MB→0.5MB），重置后第一个回合的回复摘要拿不到（404），属可接受的数据窗口空档。

### 真机反馈追加（2026-09-19，v0.3.8：编辑泡泡被退场条目吞掉修复）

用户报编辑泡泡近期基本不弹。主进程侧健康（编辑事实正常入账），复现定位渲染层：host.spawn 按 key 去重时**不排除正在退场的条目**——旧泡泡在 hold+出场动画窗口（随风≈2.5s）内收到同 key 新 spawn 时，新内容被 re-render 到正在淡出的元素上、无新活泡泡；编码智能体 1~3s 的连续工具节奏几乎每次都落进窗口（自 v0.3.0 潜伏，随风长出场 + 快节奏使它变成常态）。修复：key 去重跳过 closing 条目（新旧短暂共存，旧的照常淡出）。同场景复测：旧内容退场 + 新活泡泡并存。

### 真机反馈追加（2026-09-19，v0.3.9：随风/飘落浮动包络随高度变化）

用户规格：越靠上水平浮动越大（风随高度增强）。摆动从钟摆旋转改为双通道——translate 水平位移 + rotate 微倾斜（不再依赖 transform-origin）；出场包络递增（0→6→9→13→17px，淡出时最飘），入场包络递减（−14→10→−6→2→0px，落地收敛）。CDP 采样实证：入场 9.6px→5.7px 递减、出场 350ms 处 6.8px 与设计包络吻合。

### 真机反馈追加（2026-09-19，v0.3.10：随风/飘落节奏微调）

用户反馈：整体时间加长、飘落收敛加快。飘落 640→900ms（摆幅 65% 处归零、后 1/3 安静滑入，下落距离 -34→-38px）；随风 1000→1400ms（上升 -46→-54px、淡出延迟到后半程、终点摆幅 -18px/-3.5°）。CDP 采样：入场 90% 处位移 0px（收敛）、出场 +1.2s 仍 13.9px≈设计包络 76% 值。

### 真机反馈追加（2026-09-19，v0.3.11：随风/飘落退回两轮前版本）

用户不喜欢 v0.3.9/v0.3.10 两轮的浮动包络调整（translate+rotate 双通道、递增/递减包络、加长节奏），整体退回 v0.3.8 状态：钟摆式等幅 rotate 摆动（悬点 -80px）、飘落 640ms / 随风 1000ms。高度相关包络方案留在 git 历史与 backlog，需要时可回捞。

### 真机反馈追加（2026-09-19，v0.3.12：列位置记忆）

用户报多会话时列间频繁换位。根因：列序按最近活跃度排，两会话交替干活即乒乓。业界共识（任务栏固定序 vs Alt-Tab MRU）按身份固定槽位。实现：assignStickySlots 纯函数（memory 进/出）——会话列存活期间槽位不变；新会话优先复用空出的槽（离中心近者优先，离开后回来的会话常落回原位），焦点不再驱动布局（setFocusSession 移除）。CDP 验证：两会话三轮交替编辑相对位置稳定（旁观真实会话进出不受扰）。

### 真机反馈追加（2026-09-19，v0.3.13：拖宠物冻住全桌面动画的遮挡修复）

用户报拖动宠物时其他应用动画全停、点到前台才恢复。**根因不是卡死，是 Chromium 原生窗口遮挡检测暂停渲染**：`setIgnoreMouseEvents(false)`（悬停/拖拽的 interactive 态）会把 `WS_EX_TRANSPARENT|WS_EX_LAYERED` 一起摘掉（electron `native_window_views.cc` SetIgnoreMouseEvents，内部 `layered_` 标志仅调过 setOpacity 才置位），全屏置顶窗于是满足 Chromium `IsWindowVisibleAndFullyOpaque`（`ui/gfx/win/hwnd_util.cc`）的"完全不透明遮挡者"条件，底下所有 Chromium/CEF 应用 PageVisibility=hidden、rAF/动画全停；而样式恢复走裸 `SetWindowLong`（静默、不产生 WinEvent），被冻结窗口又会被移出 LOCATIONCHANGE 钩子集合——光标划过救不活，只有 `EVENT_SYSTEM_FOREGROUND`（点击切前台）触发重算。修复 = overlay 创建后一次性 `setOpacity(254/255)`：置位 `layered_` 并设 LWA_ALPHA≈253，此后所有穿透模式保留 `WS_EX_LAYERED`，layered+alpha<255 在遮挡判定中永不算遮挡者；99.2% 不透明度不可感知。隔离实验（右下角 46s，rig 在 zcode exec/occl-test）：模拟窗 interactive 无 layered → 受害者窗 0.7s 内 hidden、rAF 冻 9.5s；setOpacity 后仍 interactive → 1.1s 恢复、透明像素无黑块、`layered_` 在后续模式切换中保留。顺带治好"悬停宠物期间其他应用短暂冻结"。235 壳层用例全绿（+overlay-window 2）。**✅ 2026-09-20 真机验收通过**（用户确认拖宠物冻结问题已解决）。

### 真机反馈追加（2026-09-19，v0.3.14：EPIPE 弹窗刷屏防护）

自动化复验期间以 bash 后台方式重启应用，bash 会话退出后继承的 stdout 管道断裂——主进程每次 console.log（穿透状态切换、DSH 桥重试循环都会打）抛 `EPIPE: broken pipe, write` 未捕获异常，"A JavaScript error occurred in the main process" 弹窗持续刷屏（用户真机遇到）。任何"宿主控制台先于应用死亡"的启动方式（后台脚本、计划任务、服务包装器）都会踩中。修复 = `stdout-epipe-guard.ts`：入口最先给 process.stdout/stderr 挂 'error' 监听，EPIPE 静默（控制台已亡、无处可报）、其余错误码照抛。教训（已入 agent 记忆）：给用户重启 GUI 应用必须用 `Start-Process` 脱离启动，不得挂 bash 会话管道。239 用例全绿（+guard 4）。

### 泡泡样式第四批（2026-09-20，v0.3.15：漫画/便签/霓虹/墨金）

用户要求扩充泡泡皮肤。新增四个 CSS-only 样式（全部复用新提取的 `renderStandard` 共享渲染器——三个内置皮肤同步重构为同一渲染实现，行为零变化）：**漫画**（纸白+墨线描边+硬阴影的经典对话气泡，尾巴指向宠物——列上朝下/左侧回复朝右/下侧完成朝上，完成态绿色 ✓ 前缀；尾巴是旋转 45° 正方形按朝向换边框组合，三种放置位由宿主的 at-left/at-below 类驱动）、**便签**（奶油黄便利贴+半透明胶带压顶+楷体手写感，整体微倾 1.6°——倾斜走独立 `rotate` 属性避开入场动画的 transform 通道；已知取舍：飘落/随风摆动动画期间倾斜被其 fill 压制）、**霓虹**（深蓝黑毛玻璃+青色描边与文字辉光，完成态描边加亮）、**墨金**（近黑衬线排版+金色左竖栏+金色题注，完成态上下金色发丝线）。验证：241 用例全绿（+样式注册表 2）；视觉 harness（esbuild 打包样式模块 + headless Edge 截图，临时装置不入库）两轮审查——第一轮抓到漫画尾巴右指/上指变体的边框组合错误（指针顶点对应的边未换），修正后第二轮确认三种朝向、便签倾斜+胶带、霓虹辉光、墨金金栏全部正确，无重叠无裁剪。

### 后置项

**小窗化架构（方案 C）难度评估（2026-09-19，遮挡修复 v0.3.13 之后）**：用户要求评估。动机核查——A 修复治好遮挡冻结后，C 的剩余收益只有两条：①悬停宠物期间全屏窗吃掉全屏点击（窗口级交互切换的固有代价，拖拽期间鼠标捕获在任何架构下都存在）；②宠物邻带转发钩子（LL hook，已有设置项可整体关闭）。**全量 C**（单一动态边界小窗承载宠物+泡泡）：泡泡列带以宠物居中、多会话时宽度可近全屏且依赖视口钳制（packColumnBand/上下翻转）；物理飞行为 rAF 逐帧移动宠物（viewport=屏幕 DIP，地面/碰撞/§27 钳制全绑 `window.innerWidth/innerHeight`）——小窗化需要内容边界协商循环（渲染测联合区域→main setBounds→重锚定）+ 虚拟视口适配层（否则上游 petween 视口语义分叉）；v0.3.0~v0.3.12 十三批泡泡特性全部按全屏坐标验收，回归面大。估 2~3 个 Phase。**C-lite**（宠物矩形小窗交互 + 全屏层永久纯穿透只渲染泡泡/粒子）：穿透状态机/光标轮询/救援热键大半可删，估 1 个 Phase；主要风险 = 拖拽与飞行期间逐帧 `setBounds` 的移动平滑度（透明窗移动历史上有闪烁问题，需先 spike）、两 topmost 窗 z 序维护、宠物屏幕坐标跨窗同步。结论：边际收益低，搁置；重开触发 = 用户明确不能容忍"悬停宠物期间点击被全屏窗吃掉"或钩子残留问题。

**主题级进出场复杂变换**（2026-09-19 评估后入 backlog）：BubbleStyle 加可选 onEnter/onExit(el)→附加时长 钩子（宿主 close 时长取 max）；效果随主题走不加设置面。能力分层已评估——打字机展开/颜色变换/额外元素零改动即可做（render 自由 DOM+CSS stagger），逐字收起等 JS 驱动退出效果需钩子；注意 update 重渲染要跳过 stagger、打字时长按字数自适应（~1.2s 封顶）。触发：用户拍板后做示范主题（打字机进出）。

对话泡泡回复文本的展开/滚动交互、多显示器下列布局、milestone 动画按里程碑等级区分。

## Phase 11：动画编辑器独立窗口（V1.2 工作台骨架，2026-09-19 代码完成；真机验收暂缓——2026-09-20 用户拍板编辑器线先搁置）

用户需求（2026-09-19 拍板）：动画编辑器独立成**按需启动的专用窗口**，编辑手感最终对标游戏引擎时间轴；上游可同步开发。总计划 = Phase 11 骨架 + Phase 12 scrub/zoom 手感批 + Phase 13 多选/undo/菜单批 + Phase 14 曲线编辑器批（每批上游 commit→push→bump→真机验收）。本 Phase 交付**骨架 + 独立窗口**。

### 设计定案（计划审批默认拍板，AskUserQuestion 未获回复时采用推荐项）

1. **独立页面而非复用设置页**：上游新增 `/petween-animator/`（工作台布局：左动画库 | 中标量表单 + 320px 试播 | 下全宽时间轴 + JSON 视图），自包含 IIFE `lib/animator.js`；DSH 侧纯增量路由（URL 可达、设置弹窗不加入口），宠物/图片/姿势管理仍在设置编辑器。
2. **窗口模式 = settings 同款**：按需创建（首次打开才建窗）、close→hide 保草稿、退出才销毁；托盘「动画编辑器…」+ 设置页「宠物」分区工具条按钮双入口（`POST /api/petween-desktop/open-animator`，跨源写栅栏照旧）。
3. **上游零分叉纪律**：`editor-page.ts` 骨架泛化为 `static-page.ts#createStaticPageRoute`（`registerEditorPage` 签名不变，桌面装配零改动）；AnimationLibrary 纯函数草稿层提取到 `client/timeline/animation-draft.ts` 两页共用（行为零变化）；animator 编辑状态入 `AnimatorStore`（纯 TS，后续批扩 playhead/zoom/多选/undo）。
4. **数据格式与既有 UX 冻结**：动画 schema/at 归一化契约不动；设置页动画库与桌面 iframe 编辑器行为不变（后续手感升级只落 animator 页）。

### 实现

- 上游（`4fa4de8`，58 文件/1057 用例全绿）：`static-page.ts` 工厂 + `animator-page.ts`；`src/animator/`（入口/AnimatorPage/AnimatorStore/CSS）；tsdown 第 5 配置；`src/index.ts` 注册；测试 +animator-page/+animator-store/+animator-entry、ALL_ROUTES 追加；implementation-notes 追记。
- 桌面：`animator-window.ts`（单例 + close→hide + 直连 local-server URL，dev/prod 同路，无 preload）；`local-server.ts` 加 `animatorBundlePath`（env `PETWEEN_ANIMATOR_BUNDLE` 可覆盖）+ 注册；`desktop-routes.ts` 加 open-animator 路由；tray 菜单加「动画编辑器…」；设置页宠物分区加工具条（提示文案 + 按钮）；electron-builder files 纳入 `vendor/petween/lib/animator.js`。
- 测试：桌面 194 用例全绿（+animator-window 6：单例/URL/close-hide/quit 直通/销毁重建/sandbox 断言；local-server 装配断言真 bundle；desktop-routes open-animator + 写栅栏；tray 菜单项）。

### 验收

- [x] 上游 1057 + 桌面 194 用例全绿，双 typecheck 零错误；animator bundle 产物 505KB（gzip 130KB）
- [ ] 真机（dev 或 dist）：托盘/设置按钮打开独立窗口；库/表单/时间轴/试播/JSON/保存/删除/克隆全可用；关闭重开草稿保留；设置页 iframe 编辑器不受影响；退出时窗口正常销毁
- [ ] prod 打包冒烟（dist:win 后 asar 内 animator.js 伺服正常）

### 后续（本窗口手感升级批次）

- Phase 12：scrub 擦洗 + 采样预览（`sampleTimelineAt` 绕过 director 直应用）+ zoom/pan + ms 自适应时间轴 + 吸附升级（帧/事件/播放头 + Alt 临时禁用）
- Phase 13：多选/框选/批量拖动 + undo/redo（手势级快照栈）+ 右键菜单 + 快捷键全集
- Phase 14：单段 cubic-bezier 曲线编辑器（KeyframeInspector 内嵌画布）+ 上游护栏措辞修订（§2.2/§6：排除多段曲线轨道全集，允许单段手柄）

## Phase 12：手感一批——scrub 擦洗 + 采样预览 + zoom/pan + ms 时间轴 + 吸附升级（2026-09-19 代码完成；真机验收暂缓，随 Phase 11 编辑器线一并顺延）

上游 `900f1d6`（62 文件/1088 用例全绿），桌面仅 bump 指针（194 用例全绿）——窗口重开即得，零桌面代码改动。

### 交付内容（详见上游 implementation-notes「V1.2 Phase 12」节）

1. **scrub 擦洗 + 采样预览**：`sampleTimelineAt` 与播放引擎共用 compiler 数学（逐像素一致），`PreviewSession.scrubDefinition` 直写舞台层内联样式（无 WAAPI/director）；拖标尺预览实时定格；命名 pose-swap 按试播语义换图（匿名过渡换图不换）。
2. **zoom/pan**：Ctrl+滚轮以光标为锚缩放（1×..64×，工具条百分比按钮复位）；滚轮/触控板水平平移；轨道标签 sticky 悬浮。
3. **ms 自适应时间轴**：1-2-5 步进刻度（≥44px 恒定），`0/100ms/…/1s` 标签；内部 at 0..1 契约不变。
4. **吸附升级**：帧/事件拖拽吸附网格+兄弟目标+播放头（6px 捕获半径）；擦洗吸附网格+帧/事件（排除自身防粘滞）；Alt 按住临时禁用 + 工具条开关。
5. **传输感**：Space 播放/停止试播；←→ 步进播放头（Shift×10）；试播/停止/切换动画自动退出擦洗定格。
6. TimelineEditor 全部经可选 props（`advanced` 门控），设置页动画库/iframe 编辑器 V1.1 行为零变化（回归测试锁定）。

### 验收

- [x] 上游 1088 + 桌面 194 用例全绿；animator bundle 1.51MB
- [ ] 真机：打开动画编辑器窗口 → 选中动画 → 拖标尺看预览定格与换图；Ctrl+滚轮缩放围绕光标；拖关键帧吸附到播放头/其他帧；Alt 拖动禁用吸附；Space 试播

## Phase 13：手感二批——多选/框选/批量 + undo/redo + 右键菜单 + 快捷键（2026-09-19 代码完成；真机验收暂缓，随编辑器线一并顺延）

上游 `382f148`（63 文件/1105 用例全绿），桌面仅 bump 指针（194 全绿）。

### 交付内容（详见上游 implementation-notes「V1.2 Phase 13」节）

1. **多选**：Shift=同轨区间、Ctrl=增减、普通点击塌缩单选；选择为字符串键 Set（V1.1 单选=单元素集合，行为零变化）；空白轨道拖动=跨轨道时间带框选（含事件）。
2. **批量编辑**：多选拖动整体随锚移动（逐 tick 累加、越界钳制、碰撞静默丢弃）；Ctrl+D 复制所选帧（+0.05，副本成为新选择）；Delete 批删（过渡唯一 pose-swap 保护）；←→ 批量微调；Esc 清选。
3. **undo/redo**：手势级历史（600ms 窗口合并=一次拖拽一步，栈深 100）；Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y + ↶↷ 按钮；切选重置；库级操作不入历史。
4. **右键菜单**：菱形（复制/删除）/事件标记/空白轨道（在此加帧）/标尺（播放头移到这里）/轨道标签（删除轨道）。
5. **工具条**：「? 快捷键」速查卡。

### 验收

- [x] 上游 1105 + 桌面 194 用例全绿
- [ ] 真机：Shift/Ctrl 点选多帧 → 拖一个批量移动；框选后 Delete/Ctrl+D；Ctrl+Z 撤销整个拖拽为一步；右键各目标菜单动作；Esc 清选

## Phase 14：手感三批——单段 bezier 曲线编辑器 + 护栏修订（2026-09-19 代码完成；真机验收暂缓，随编辑器线一并顺延；v0.2.4）

上游 `be701c5`（64 文件/1110 用例全绿），桌面 bump 指针 + 版本 0.2.4。

### 交付内容（详见上游 implementation-notes「V1.2 Phase 14」节）

1. **BezierCurveEditor**：DevTools 风格 SVG 画布——参数化曲线绘制、控制点引导虚线、双手柄拖拽（x 钳 [0,1]、y 钳视图窗 y∈[-1,2]）；与检查器四个数字输入双向联动（同层缓动同步纪律不变）；数字输入保留为精确/可达路径。
2. **护栏修订**：development-spec §2.2 与 v1.1 plan §6 改为「多段曲线轨道/曲线编辑器全集」不做，单段手柄画布明确豁免。

### V1.2 动画编辑器批次总结（Phase 11~14 全部代码完成）

上游四个提交：`4fa4de8`（工作台骨架+独立页）→ `900f1d6`（scrub/zoom/ms 标尺/吸附）→ `382f148`（多选/批量/undo/菜单/快捷键）→ `be701c5`（曲线编辑器+护栏）。测试基线 55→64 文件 / 1044→1110 用例。桌面四批均为指针 bump（零桌面代码改动，P11 除外）。

### 验收

- [x] 上游 1110 + 桌面 194 用例全绿；v0.2.4
- [ ] 真机：选中关键帧 → 缓动切「自定义 cubic-bezier」→ 拖手柄看曲线实时变化（数字输入联动）→ 试播感受缓动；命名预设切换
- [ ] dist:win 产物冒烟（asar 内 animator.js 伺服 + 独立窗口全链路）

## 待用户拍板项

- [ ] publish 目标仓库与发版流程（appId 已在 electron-builder.yml 定为 `com.traveritas.petween`，仅发布仓库待定）
- [x] ~~数据目录策略确认：独立 `userData/petween-home/` + 一次性从 `~/.dsh/petween` 导入~~（已按推荐落地并经发布验证，存档关闭）
- [ ] 是否需要 macOS 支持（穿透/托盘 API 有平台差异，MVP 只验 Windows）

## 2026-09-19（下午）：真机反馈修复批——三栏 DCC 布局重构 + 光标/预览两修（上游 `50942a5` / 桌面 `9c678a7`）

用户初测三问题，全部处理：

1. **光标闪动**（默认↔crosshair/ew-resize/grab 来回抢夺）：根因两处——`.rulerTick` 刻度文字没有 `pointer-events:none`（盖在标尺上导致命中测试翻转）+ 时间轴无 `user-select:none`（拖动触发文本选择出现 I-beam）。修复 + `:active` grabbing 光标。
2. **预览穿插**：预览此前是裸 PetRenderer 塞进 flex 格，舞台层动画 transform 越界漂到相邻组件上。现在收容进 `stageBox`（relative + overflow:hidden + 300px + 居中 + 底部径向渐变地面）。预览的正确位置：中列上方的「预览」面板（program monitor）。
3. **布局重构**（放开旧排版，参考美学 skill=impeccable/Operate 模式）：三栏 DCC 语法——**左列动画库 | 中列预览舞台+传输条、时间轴面板 | 右列属性/检查器/操作**。检查器经 TimelineEditor 新 `inspectorTarget` portal prop 停靠右栏（缺省仍内联，V1.1 行为不变）；传输条带播放头 tabular-nums 时间读数；撤销/重做并入时间轴面板头；≤1280px 属性栏折叠到时间轴下方。审查方式：无头 Edge CDP 截图（空态+选中态）+ DOM 几何探针（临时 harness，已删）。

上游 1111 / 桌面 194 用例全绿。**真机复验待用户**（重装 dist 或 dev）。

- **补记（同日第二轮）**：光标闪动第一轮修复无效；改证据法——CDP 命中测试逐 2px 采样光标地图，真根因=lanes 面板 8px 内边距环与轨道间 2px 接缝全是 `auto`。修复：面板表面统一 crosshair（`.timelineLanes`/`.timelineRow`），标签列显式 default（上游 `f21d904` / 桌面 `fef3cdc`）。复测地图干净。

- **退出报错修复（同日）**：用户报每次退出弹「A JavaScript error occurred in the main process — TypeError: Object has been destroyed」。栈指向 overlay `closed` 处理器 → pointer-through.dispose：dispose 读取已销毁窗口的 `win.webContents`（Electron 在 destroyed 窗口上抛错）。修复：attach 时捕获 webContents 引用（destroyed EventEmitter 仍可 removeListener）+ apply/evaluate 加 `win.isDestroyed()` 守卫（`bd31993`）。复现钩子 `PETWEEN_QUIT_AFTER_MS`（env 触发 app.quit，留在代码里补退出路径冒烟盲区——修复前自动退出卡在报错对话框 3 僵尸进程，修复后干净退出零输出）。注意：此 bug 自 Phase 3 就潜伏，退出冒烟此前从未自动化过。（✅ 用户真机复验：退出无报错。）

## 2026-09-19（傍晚）：光标闪动终局修复——转发钩子只在宠物近带常驻（`a32e2e5`）

三轮排查的完整弧线：①轨道区 CSS 补丁（必要不充分）→ ②预览容器统一 grab（修好宠物悬停闪）→ ③用户判别「只有 Petween 窗口闪/关宠物无效/所有自定义光标区域都闪」+ 上游证据锁定真根因：**`setIgnoreMouseEvents(true,{forward:true})` 的转发实现是系统级 WH_MOUSE_LL 钩子，常驻期间同应用 Chromium 窗口的异步光标判定被干扰**（Electron 已知 bug 族「setIgnoreMouseEvents on Windows / flickering cursor」；原生程序同步设光标故其他程序不闪；桌面宠物自身是钩子宿主故不闪；关宠物只隐藏精灵、overlay 窗口与钩子仍在故无效）。

**修复**：pointer-through 改三态机——`interactive`（宠物上/拖拽）/ `forward`（宠物包围盒 +96px 进带 / +128px 出带滞回，钩子只在带内安装）/ `plain`（纯穿透零钩子，默认态）。渲染侧既有 1s keep-alive 本就携带 bodyRect（不依赖鼠标事件），主进程轮询在无钩子时依然有新鲜几何；hover/拖拽精修只在带内生效。always-through 模式彻底不装钩子。设置页「鼠标移动转发」文案更新为近带语义。新增 forward-band 逻辑测试 7 例 + glue 三态断言，202 用例全绿。

**✅ 2026-09-19 用户真机复验通过**：时间轴/文字/宠物悬停全部不再闪动，宠物交互正常。真机反馈修复批（光标三连修 + 预览收容 + 三栏重构 + 退出报错）全部关闭。

## 2026-09-19（夜）：physics 可见像素碰撞箱——`collision.ignoreTransparentPixels`（上游 `0a83a24`，默认关）

用户提问「碰撞箱能否忽略图片的透明像素 + 不同状态碰撞箱变化对 physics 的影响」。评估结论：引擎已有 bodyRect→insets 地基（剥掉 stage 方块 padding），但姿势图**文件内部**的透明边缘仍算碰撞；且 bounds 每帧按最新快照重算（为飞行中改缩放设计），状态/flashPose 换姿势中途换盒本就被支持——影响限于一次性夹持跳动（≤边距差）与落定后贴地漂移（锚点模型固有权衡），无稳定性风险。拍板：physics 仓内闭环（零 petween 改动）、默认关、保持逐帧重算。

实现（全部在 petween-physics 0.3.0）：

- `alpha-bounds.ts`：纯扫描器（alpha ≥ 阈值的紧致包围盒，归一化分数，L 形/离散斑点取并集盒）+ URL×阈值缓存扫描器工厂（≤512px 降采样封顶内存，失败不落缓存可重试）。姿势资产仅 PNG/WebP/JPEG 静态图，一次扫描即全量真值；JPEG 无 alpha → 全不透明 → 恰好空操作。
- `pose-collision-bounds.ts`：(petId, poseKey) → `GET /api/petween/pets/<id>`（逐问取新 + 在飞去重；快照 poseKey 已是 fallback 解析后槽位，无需复刻主插件 fallback 链）→ `/petween-assets/<id>` → 扫描。任何失败静默 null，控制器回退图片盒。
- `throw-controller.ts`：新增可选 `getPoseAlphaBounds` 接缝；insets 按分数×bodyRect 精修；拖拽起步预热（扫描赶在松手前落地）、姿势身份变化逐帧检测（覆盖飞行中换姿势）、陈旧答案守卫（换姿势竞态丢弃）、null 答案下个手势重问（资产晚导入可恢复）。
- 配置 `collision` 分组：`ignoreTransparentPixels`（默认 false）+ `alphaThreshold`（1..255 整数，默认 1=只忽略全透明）；设置卡「碰撞箱」分组两行；§12 共享配置摘要标签同步。宿主 PUT 校验/repairConfig 走既有单表。
- 双入口（DSH client + desktop companion）同 provider 接线，符合三纪律（扫描器为注入缝）。

physics 190 用例全绿（基线 166 + 新 24：扫描器几何/阈值/缓存、provider 映射/新鲜度/不拒绝契约、控制器收紧/回退/陈旧/预热/飞行中换姿势）；桌面 bump 指针后 typecheck + 233 用例全绿。**✅ 2026-09-20 真机验收通过**（用户确认碰撞箱按可见像素工作）。原验收口径：设置卡开「碰撞箱→忽略图片透明像素」→ 扔宠物观察贴墙/贴地间隙按可见像素、换状态/flashPose 切图后弹跳仍顺滑。

## v0.4.0 里程碑评审（2026-09-20，五路子智能体综合评审）

评审范围：v0.1.0 标签以来 48 提交 / ~6700 行新增（Phase 9 zcode 连接器、Phase 10 泡泡线两批十六轮、Phase 11~14 动画编辑器 V1.2、physics 0.3.0、穿透三态机、EPIPE 守卫）+ 当前树整体。五路评审员（主进程 / 渲染层 / 测试 / 文档 / 安全）并行只读评审，**零 P0**、5 项 P1 + 一批 P2，当场修复后 264 用例全绿打标签。

### 同日验收收口（先行）

碰撞箱（physics alpha-tight）、遮挡修复（v0.3.13）、泡泡线（含皮肤四批）真机验收 ✅；动画编辑器线（Phase 11~14）拍板搁置、验收顺延。至此 v0.1.0 以来的「真机验收待用户」欠账清零（编辑器线除外）。

### 已修复（随本里程碑提交）

**P1（5 项全修）**：

1. follow 模式焦点切换吞事件（zcode-connector）：切换目标后重放旧视觉即 return，触发切换的 user-prompt-submit 本身不发射——被门控后台 stop 压住的会话切回时宠物卡 success 脸到下一个事件。修复：重放仅在旧视觉 ≠ 当前事件时发生，然后落入公共发射路径（当前事件 + turn/start + scheduleIdle 全部生效）。
2. 设置页 PUT 失败重试死代码（settings/main.tsx）：flush 回调不置空 `timer.current`，重试守卫 `=== null` 永假——瞬时失败静默丢设置。修复：flush 进入即置空。
3. `animationId` 存量迁移丢失（v0.3.x 重构把 v0.2.5 的迁移丢了，`LEGACY_BUNDLED_EXITS` 成死代码）：≤0.2.3 用户升级静默回落默认动画。修复：migrateTypeConfigs 恢复 animationId 读取（enter=原值、exit=查表，新键优先）。
4. **Host 头白名单（安全，收口 v0.1.0 backlog #4）**：v0.1.0 的「随机端口 + 无 CORS 头 + 跨源写栅栏」对 DNS rebinding 不充分——rebinding 工具先扫临时端口段再同端口寄生，Origin↔Host 相对比较尽数放行，GET 可读面含 /stats（sessionId+filePath）与 /dialogue（AI 回复预览）。修复：routes-host dispatcher 强制 Host 精确白名单（`127.0.0.1:<port>`/`localhost:<port>`，一处改动覆盖壳层+vendor 全部路由），dev 代理加 changeOrigin: true。
5. 文档失真批：AGENTS.md 子模块指针（8190ae6/0a83a24，§2 与基线行矛盾已消）、决策 4（穿透三层→三态机+setOpacity）、决策 7（migrateLegacyHome→legacy-import.ts）、状态流水 2026-09-20 验收同步；docs/02+04 dev proxy 清单（缺 petween-desktop/physics、误含 petween-editor）；docs/06 §8.5 反引号内容丢失修复 + §6 模块清单补齐 connectors 八文件；README 状态段 v0.1.0→v0.4.0。

**P2（当场修复 14 项）**：zcode-hooks 五连（归属判定改精确 cfg 路径匹配——前缀会误删用户在 `zcode-hooks.bak/` 等兄弟目录的条目；install/uninstall 串行化 promise 链 + 随机 tmp 后缀；非数组事件值拒绝改写不静默丢；写前 `.petween-bak` 备份；不强制翻 `hooks.enabled`——用户刻意全局禁用 hooks 时保留其设置）；ws 适配器 close 后保留 NOOP error 监听（teardown 窗口的 receiver 错误不再变 main 进程弹窗）+ maxPayload 1MiB；legacy-import 失败弹窗（原先 void 无 catch）；`companions.enabled` per-id 合并（局部 PUT 不再重置兄弟插件开关）；回复/完成泡泡 holdMs=0 语义修正（立即关闭而非永不关闭）；setMaxBubbles 排除 left/below 条目（潜伏）；bump 在入场动画窗口内抑制（bump 占用 animation 属性会取消并重放入场动画）；shared-host 后到 acquire 警告；dialogue 扫描行长 >4MB 跳过；hud-logic reconcileSession 补 thinking 对称兜底（事件环回绕丢 state 事件时按 summary 收泡）；三窗 will-navigate/setWindowOpenHandler 锁死 loopback（新 window-nav.ts）；disposeTimer 死代码清理。

**补测试（+23，241→264）**：follow 切换双用例（含 gated-stop 回归）；animationId 迁移双用例；Host 栅栏 7 例（routes-host 单测 4 + local-server 真实服务器 3，含 rebinding 形态 Host==Origin）；zcode-hooks 5 例（前缀陷阱/非数组拒绝/enabled 保留/.bak/并发串行化）；destroyed 窗口回归（bd31993 形状，webContents getter 抛错模拟）；dialogue-routes 4 例（新文件——唯一内容级端点此前零测试）；hud 环回绕兜底 2 例；三窗导航锁断言。

### 信任边界结论（安全评审，存档）

loopback 无鉴权、本机进程等权两条 v0.1.0 边界仍然成立；浏览器页边界本次升级——随机端口对 rebinding 攻击者不构成屏障（临时端口段可扫），Host 白名单落地后读面（/stats、/dialogue）与写面（DELETE 宠物、PUT config、hooks 安装）对 rebound 页面均 403。其余核实为阴性：/petween-assets 与 /assets 双守卫无路径穿越、dialogue session 白名单+固定文件名模板走不出 rollout 目录、全仓零 HTML 注入 sink（textContent-only）、三窗 sandbox+contextIsolation 全开、preload 单通道、desktop-settings 白名单重建无原型污染。

### Backlog（按价值排序，未修项）

1. 测试 A1/A2：bubble-host DOM 生命周期与 stats-hud companion execute 映射的 jsdom 行为测试（v0.3.5/6/8 三个历史 bug 均发生在该层，现仍靠真机；stub offsetWidth/offsetHeight + fake timers 可测）。
2. 测试 A5：e2e 升级为生产载荷（`--data-binary @-` stdin JSON → connector+ledger 全链）+ install/uninstall 真实文件 e2e。
3. 主进程：dialogue 候选行整行驻留改边流边 parse 只留最后一条（长会话回合结束的数十 MB 瞬时抖动）；bridge 主循环 crash 后自动退避重启（现仅设置开关可复活）；flushSync 与在途异步写的陈旧覆盖窗口（毫秒级，低危）；与 zcode 客户端对 config.json 的跨进程双写（已用 .bak 缓解，根治需文件锁）。
4. 渲染层：column 翻转下置与 below/left 栈的互避（宠物拖到屏幕顶部的退化重叠，已知取舍）；companion 重挂载从 cursor=0 重放事件环（开关无关插件时历史完成/回复泡泡复现）——init 先拉快照预热；settings-card 把 fetch 移出 setState updater。
5. 安全：上游 petween 编辑器/动画器 HTML 壳 CSP（petween 回流）；prod 设置页 CSP 仍含 dev 17777 字面量（构建期条件化）。
6. 观察项：electron PR#52631/#52633 合入 44.x 后复验穿透自愈面（沿袭 Phase 7 watchlist）。

### 里程碑动作

版本 0.3.15 → 0.4.0，打标签 `v0.4.0`。产物构建不在里程碑内（与 v0.1.0 同例，需要时 `pnpm dist:win`）。

## Phase 15：Claude Code 连接器（✅ 2026-09-20 完成并真机验收关闭）

规格 = **docs/07**。泡泡线 + 统计账本已连接器无关，CC 连接器落地即点亮状态联动 + 全套泡泡 HUD。

### Spike 结论（2026-09-20，本机 CC 2.1.234 + 官方 hooks reference）

- hooks 配置在 `~/.claude/settings.json` 顶层 `hooks` 键，形状与 zcode 同构（zcode 即仿 CC）；无 `enabled` 开关（全局开关 `disableAllHooks`，不碰）。
- exec 形式（command+args）直接 spawn 不过 shell（shell 形式走 Git Bash）——curl.exe 是真 exe 正合适，与本机已有的 Pebrel hooks 实测共存形态一致。
- `timeout` 单位是**秒**（zcode 毫秒）；SessionEnd 事件共享 1.5s 完成预算（回环 curl 毫秒级，无碍）。
- **settings.json 有文件监听热加载——安装/卸载即时生效，无需重启 CC**（与 zcode 的「重启客户端生效」相反）。
- stdin 载荷公共字段含 `session_id`/`prompt_id`/`transcript_path`/`hook_event_name`；工具事件加 `tool_name`/`tool_input`；**`prompt_id` 即回合 id → turnId**。
- matcher 语义同 zcode 族（纯字符集=精确/`|` 列表，含正则字符=不锚定 RegExp.test）。
- 不用 CC 原生 http handler 类型：有 `allowedHttpHookUrls` 白名单约束且 URL 进用户文件（每 boot 换端口）；curl+cfg 方案端口发现只动自己目录。

### 实现（264→302 用例全绿 +38，详见 docs/07）

1. **共享层抽取（zcode 行为零变化，37 个 zcode 连接器用例护航）**：`hook-connector.ts`（会簿/watchdog/follow/stats/信封引擎，按 profile 参数化）、`config-io.ts`（v0.4.0 加固的读改写基建，按路径串行化）、`route-helpers.ts`（路由脚手架）。zcode 三文件变薄壳；Phase 16 Codex 是第三个消费者。
2. **cc-connector**：CC profile——`session-end`（SessionEnd 独有 kind：清定时器后立即 dispose，**排在排惰性定时器之前**——否则残留定时器在死会话上二次 dispose，测试钉住）；PermissionRequest 映射 permission-request（v0.6.3 摘除 Notification——其闲置提示曾把 success 脸污染成等待脸）；编辑工具 matcher `Edit|Write|MultiEdit|NotebookEdit`（精确列表无需正则）。
3. **cc-hooks**：cfg 渲染/端口重写 + settings.json 合并安装/卸载，四加固全量适用（精确 cfg 路径归属/串行化/.petween-bak/非数组拒绝）；卸载后全空删整个 hooks 键；env 密钥等顶层键原样保留。
4. **cc-routes**：`/api/petween-desktop/connector/cc/event|status|install|uninstall`；stdin JSON 解析（prompt_id→turnId）；1MB 上限/session 白名单/永远 204。
5. **接线**：desktop-settings `connectors.cc`（enabled/followLatestUser 默认开/关，分组隔离有测试）；index.ts 镜像 zcode 块；设置卡 `HookConnectorCard` 泛型化双实例（CC 文案注明无需重启）。

### 验收（✅ 2026-09-20 用户确认「现在没问题了」）

- [x] 设置→连接→Claude Code「安装 hooks」→ 状态点亮；**无需重启 CC**，新会话即联动
- [x] 猫在工作（编辑/命令/其他工具分别对上表情）→ 思考 → 等待授权（PermissionRequest；Notification 已在 v0.6.3 摘除——其「等待输入」闲置提示曾把 success 脸污染成等待脸）→ 成功 60s 衰减
- [x] 泡泡：思考计时/编辑行数（CC 的 Edit/Write/MultiEdit 形状）/完成摘要/回复文本（v0.5.1 解绑后 CC 也点亮）全链路（dialogue 端点 turnId 匹配返回经 `claude -p` 实弹验证）
- [x] 会话结束（SessionEnd）宠物立即收泡回待机；CC 崩溃 30min 惰性 dispose 兜底
- [x] 卸载 hooks：settings.json 恢复（外来 hooks/env 完整）

验收过程追加修复：v0.6.1（dev 代理 origin 重写 + 连接器 disable 接线 reset()）、v0.6.3（Notification 污染摘除）。

### 后置项

- ~~CC 对话泡泡（回复摘要）~~（✅ 同日解绑批完成，v0.5.1：dialogue 多源化 + cc-dialogue-source 父链回溯，详见 docs/07 §9；真机验收项并入下方清单）。
- Notification 触发面观察（docs/07 §6.2）：不合适的等待视觉 → 摘掉 Notification 注册只留 PermissionRequest。

## Phase 16：Codex 连接器（✅ 2026-09-20 完成并真机验收关闭）

规格 = **docs/08**。spike 推翻了 Phase 7 的「command hooks 家族」预判：**Codex 0.154 已实现 CC 兼容的原生 hooks**（codex-rs 引擎名就叫 `ClaudeHooksEngine`，配置在 `~/.codex/hooks.json`，本机 deja-vu hooks 共存实测）——于是 Codex 直接复用共享引擎成为第三个 profile，一行都没浪费在文件监听上。

### 要点

- **命令串形态**：Codex hook 的 command 是单字符串经 cmd.exe /C 执行（无 args 数组）——cfg 路径在命令串里加引号；timeout 秒。
- **`turn_id` 原生**：stdin 载荷直接带官方回合 id（比 CC 的 prompt_id 还直接）；`transcript_path` 可 null（disable_response_storage）。
- **Interrupt → session-start**：用户打断立即 idle（不注册则打断后猫卡工作脸到 30min 兜底）；无 Notification 事件。
- **信任机制**：hooks 哈希比对——安装后 Codex 请求一次信任确认（设置卡文案注明）。
- **对话泡泡零成本点亮**：rollout 的 `task_complete` 事件直接带 `turn_id` + `last_agent_message`——dialogue 源流式留最后一个非空条目即可（Phase 15 的解绑在此兑现）。
- 编辑行数：apply_patch 走 line-count 的 patch 分支，CC 形状 Edit/Write 兜底。

### 验收（✅ 2026-09-20 用户确认「现在没问题了」）

- [x] 设置→连接→Codex「安装 hooks」→ 信任确认（v0.6.4 后可由预铸哈希跳过，见 docs/08 §3.1）→ 新会话联动
- [x] 表情全链路（thinking/working×3 类/waiting/stop 衰减/打断立即 idle/SessionEnd 收泡）——exec 模式实弹验证全序列送达后用户交互模式确认
- [x] 泡泡四件套（对话泡泡 task_complete 直取）
- [x] 卸载恢复（deja-vu hooks 完整——v0.6.2 取证时实测其条目原样保留）

验收过程追加修复（整个侦探链详见 AGENTS v0.6.2~v0.6.4 行）：v0.6.2（Rust regex 无前瞻→路由侧分类 + 超时钳位写 3）、v0.6.4（curl 在 Codex hook 执行器下 stdin+网络必死→node sink 传输 + 重装堆积归属修复）。Codex exec 模式的 Stop 事件 hook 对任何命令失败（回合收尾拆机竞态，Codex 侧问题）记录于 docs/08 §6 观察项。

### 后置项

- 信任确认 UX 与 hooks.json 热加载的实测口径（docs/08 §6.1/6.2）；matcher 别名表逐个实测；工具名漂移观察。

## v0.7.0 里程碑评审（2026-09-20，五路子智能体综合评审）

评审范围：v0.4.0 标签以来 9 提交 / ~4100 行（Phase 15 CC 连接器、对话泡泡解绑、Phase 16 Codex 连接器、四批验收修复）。五路评审员（主进程/渲染层/测试/文档/安全）并行只读评审，**零 P0、1 项 P1 + 一批 P2**，当场修复后 364 用例全绿打标签。

### 已修复（随本里程碑提交）

**P1（1 项）**：config-io `readConfigObject` 把一切读失败当「全新安装」——CC 热加载 settings.json 的原子 rename 间隙/AV 短锁会让我们的 install 读到瞬时错误→判定 fresh→把用户整份配置（env 密钥等）塌缩成只剩 hooks 写回。修复 = 仅 ENOENT 视为缺失，其余 rethrow。

**P2（当场修 18 项）**：安全 4（codex 归属判定改 token 精确匹配——子串匹配可让卸载误删「提到」我们路径的外部 hook；config-io rename 失败清理含密钥的 tmp 残留；dev 代理 origin 改条件重写——无条件重写会把同站 localhost 页面洗白过栅栏；findNodePath 优先已知安装根再回退 PATH + 剥引号）；主进程 7（apply_patch 载荷键实证为 `input`→line-count 补分支 + write 未识别形状归 null；codexNodePath 改安装时现查；sink 端口 fail-closed + node<18 fetch 守卫；zcode-hooks 畸形值拒绝与 cc/codex 对齐；zcode-routes 改用共享 route-helpers；引擎删死契约 toolNameByKind；cc-connector 头注释修正）；渲染 5（api() 失败透传服务端 message（安装拒绝/缺 Node 不再只显示 HTTP 500）；Codex 卡片补 node 前置与专属 transportNote；删 `as never` 断言；HUD 跳过已消失会话的环事件（disable 后不再弹最后一枚泡泡）；useSettings 响应合并 in-flight pending（防 300ms 视觉回弹））。

**补测试（+12，352→364）**：codex-sink-e2e（执行级：真路由表送达/服务器消失 exit 0/cfg 缺失 fail-closed）；line-count 的 apply_patch input 形状 + write 未识别 null；config-io 的 ENOENT-only 语义与 tmp 卫生；desktop-settings 三连接器 it.each；两处测试修正（cc-dialogue sibling 在 Windows 的 no-op、恒等替换断言）。

### 连接器是否插件化（2026-09-20 用户提问，拍板：暂不）

现状：连接器是 main 进程内编译模块（共享层 hook-connector/config-io/route-helpers/dialogue-text 已构成「代码级 SDK」）；伴生插件宿主（Phase 8）是 renderer 侧体系（stats-hud/physics），无力承载连接器所需的路由注册/用户配置写入/FS 读取。**不改的理由**：① 运行时加载 main 代码 = 任意代码执行面，需要信任机制（Codex hooks 信任哈希的折腾是鲜活教训）；② 无第三方需求——沿用「独立编辑器分发」的触发式决策（出现 ≥1 个第三方连接器作者或自研连接器 ≥5 个时再抽 manifest 式包格式）；③ Phase 16 实证 in-tree 加一个连接器 ≈ 1 天，现速度无痛点。中间路线已就位：继续硬化接缝。

### Backlog（按价值排序，未修项）

1. ~~follow 模式跨连接器互不感知~~（✅ v0.7.1：引擎 onFocusAcquired + retireFollowTarget，index.ts 仲裁器——任一连接器获得跟随时退休其余 target）。
2. index.ts 启停翻转接线提纯函数并测（A2）；zcode-e2e 补 stdin JSON 现行形态（A4）。
3. ~~isProjectsPath/isSessionsPath 的敌对形状钉测试~~（✅ v0.7.1：cc/codex 两源各钉遍历出根/兄弟前缀/UNC/小写盘符）。
4. ~~路由测试 mock 清理队列补全~~（✅ v0.7.1）。

### 里程碑动作

版本 0.6.4 → 0.7.0，打标签 `v0.7.0`。

## Phase 17：roamer companion——宠物自主行为（游荡 / 待机动作 / 捣乱）（2026-09-21 代码完成；真机验收待用户）

用户需求：宠物在闲时（可配置成永远）自己游荡；从桌面外拉出可自定义随机内容池的窗口（借鉴 Mac 的 Desktop Goose）；捣乱；外加待机小动作。**待机、游走、捣乱各类内的子功能均独立开关。** 经两轮子智能体代码级调研（companion API 能力面 / 装配级细节）后拍板方案并四批交付。

### 设计决策（评审后定案）

1. **零 petween core 改动**。全部能力走 `petween/client` 扩展面：`requestPositionControl()`（60fps 位置租约）、`flashPose/flashAsset`（临时换图）、`registerPoses`、`playAnimation`（loop/once，实例可 dispose）、`subscribeStage/subscribeUserDrag`。上游零回流、零 submodule bump。
2. **in-tree companion**（`src/renderer/companions/roamer/`，照 stats-hud 模式），不建独立仓库（2026-09-21 用户问询后确认）：迁移路径已被 physics 验证（目录自包含 + 只依赖扩展面类型 + 结构镜像 DesktopCompanion），触发信号 = DSH 端需要 roamer 的那天，迁移时补一个 config hub（physics 模板）。
3. **明确排除**：输入类捣乱（抢鼠标/拖系统窗——overlay 不可聚焦 + WH_MOUSE_LL 常驻钩子闪光标坑族）；拉出的内容窗不可交互（可点击需扩穿透三态协议三处，触发式后置）。
4. **姿势美术不随插件发行**（通用图与用户自定义宠物形象冲突）：默认表现 = 纯 motion 动画（无图也成立）；设置卡支持每行为上传自定义图覆盖（走现有 `POST /api/petween/assets`，URL 存 options）。**朝向镜像砍掉**：pose 通道 `zoom` 校验域 0.2..8 无负值，无法水平翻转（计划预案兑现）；peek 用「向边缘外倾身」的 motion 偏移替代，无需姿势。
5. **架构**：纯决策引擎（`engine.ts`，事件→命令，rng 可注入，node 直测）+ 薄 runtime（`companion.ts`，租约/rAF/视觉解释器）+ DOM 层（`windows.ts`，bubble-host 骨架）+ host 装配（`roamer-assembly.ts`：默认动画幂等注册，无路由无 store，builder/proxy 零改动）。

### 交付明细（四批提交）

- **批 1 骨架+游走**：引擎门控（idle-only/always、总开关、dragging、reducedMotion）+ 租约纪律（**仅走 leg 期间持有 PositionDriver，与 physics 抛掷互让**：lease null → 顺延 3s 重试；drag start 弃 leg 不 commit；hidden settle；会话丢失全释放并重新 arm）+ 常速 rAF 走 leg + `user:roamer-walk-bob` loop 动画 + 走路姿势覆盖（flashAsset holdMs=leg 时长+500ms，中途打断用「重闪当前状态槽位 1ms」还原技巧）+ 设置卡游走区。
- **批 2 待机动作**：doze/lookAround/sway/shake 四动作（默认 once 动画：瞌睡点头/左右张望/晃悠/抖毛；doze/lookAround 可传自定义图）+ 引擎 idle-action 占用模式（与游走共享 when 门控与 autonomy 前置；`userDragging` 标志闭合 drag 事件与 snapshot.dragging 的竞态）。
- **批 3 拉窗+便签+内容池**：mischief 决策层（优先级 mischief > wander > idle）+ 拉窗 = 走到最近屏幕边缘后从边缘外滑入内容窗（DOM 不受 §27 钳制；**任何弃 leg 路径静默丢弃载荷——绝不向拖拽中/隐藏窗口 spawn**）+ 便签 = 原地抖毛 + 随机倾斜贴纸（停留 90s vs 拉窗 25s）+ windows.ts DOM 层（fixed 全屏 pointer-events:none、z-index 低于泡泡层、enter/exit CSS class + 定时器移除、dispose 清场）+ 设置卡捣乱区与内容池管理（图片上传/文本添加/删除，存 `companions.options['roamer']`）。
- **批 4 冲过+探头**：dashAcross = 4× 速度冲到对侧（无需内容池）；edgePeek = 走到边缘后向屏幕外倾身（transition.x 视觉偏移，左右两方向动画）+ peek 占用模式；内容池空检查收窄到需要内容的动作。

### 关键语义

- 决策优先级：mischief > wander > idle；三类共享 autonomy 门控（会话可用 + 非拖拽 + 非 reducedMotion + when 模式：idle-only 要求 visualState==='idle'，always 任意状态但姿势仍显示工作状态）。
- 所有打断路径（drag/hidden/会话丢失/grace 阀）统一「弃则不 commit、完成则 commit 后 release（release 必须晚于 commit 落地，20s 超时兜底）」；endWalk 一律从结束时刻重排暂停（修复批 1 测试抓到的「过期 nextWanderAt 立即再走」bug）。
- 选项轮询 3s（stats-hud pullOptions 模式，改设置不重挂）；`normalizeRoamerOptions` 双侧共用（卡片与 runtime 同源）。

### 测试（376 → 413，+37；CI 修复 +1 已入账）

`tests/companions/roamer-engine.test.ts`（node，28 用例：游走生命周期/门控矩阵/打断/租约拒绝重试/会话重建/grace 阀/待机调度与取消/mischief 四动作/池空静默/normalize）；`tests/companions/roamer-windows.test.ts`（jsdom + fake timers，6 用例：拉窗左右边缘定位与滑入类/便签皮肤与停留差/DOM 移除时序/dispose 清场）；`tests/main/roamer-assembly.test.ts`（真 route table + host service，3 用例：注册落地/幂等/不覆盖用户编辑）。

### 待用户真机验收清单

1. 闲时 ~6s 后开走，速度/节奏/边界行为（下三分之一偏置、整只宠物不出屏）；设置改速度/间隔 3s 内生效。
2. 拖住宠物立即停且不弹回；扔出（physics）期间 roamer 不抢租约，落地后恢复决策。
3. 「永远」模式下 agent thinking 时宠物照走、姿势仍为工作状态；idle-only 下忙碌不动。
4. 待机动作按间隔出现（打盹 2.6s/张望 1.8s/晃悠 2.2s/抖毛 0.7s），拖拽立即收。
5. 内容池加一张图 + 一条文本 → 捣乱触发时拉窗从宠物所在边缘滑入、25s 淡出；便签随机位置 ~90s。
6. 各级开关独立生效（关游走走停、关单动作只跳过该动作、关捣乱无窗口）；关插件整体（设置→插件）行为全停、已有窗口清场。
7. 打包版抽查（`pnpm dist:win`）同验。

### 后置项（backlog）

- 便签/拉窗位置避让（当前随机带不避任务栏/宠物本体）；拉窗可交互化（穿透协议三处扩展）；姿势覆盖的上传入口 UI（当前仅 options 直写，批 3 卡片已有内容池上传、行为姿势上传未做卡片控件）；走路朝向（需上游开 pose 镜像缝，回流项）；多显示器游走（overlay 仅主屏的既有约束）；便签文本池与拉窗池分离。

## Phase 18：设置窗重构——插件分页 + 每页 取消/应用（2026-09-21 代码完成；✅ 同日真机验收通过）

用户两项拍板：①插件分类挪到导航最底部、点击展开各插件子页、每插件独立页面（设置内容**始终展示**，可先配置后启用）；②保存模型统一为 Windows 属性对话框式 取消/应用（**每页独立**草稿与底栏，切页有脏警告：留下 / 丢弃更改并离开 / 保存并离开）。

### 背景：原保存通路盘点（重构动机）

原四条通路行为不一致：壳层 `useSettings`（乐观应用 + 300ms 防抖 PUT + 重试，但无保存状态显示）；roamer/stats-hud 卡各自 fetch + 即时 PUT 且 **fire-and-forget（失败静默丢失）**；physics 卡自带防抖 PUT + 保存态显示（三卡中最完善但孤岛）；宠物编辑器 iframe 自有草稿模型（不动）。**没有任何通路等关窗才保存**——用户感知的「不舒服」实为缺提交边界/无保存反馈/静默丢失三件事，本重构一并解决。

### 架构

- **每页草稿**（`usePageDraft`）：页挂载时 load 自己的切片（5 次退避重试 + 失败态重试按钮）→ baseline + draft；改动只进 draft；应用 = PUT 切片（服务端深合并）并采纳服务端归一化结果为新 baseline；取消 = 回滚 baseline；dirty = `jsonDeepEqual`（`src/renderer/settings/draft.ts` 纯函数）。
- **导航守卫**：活跃页经 `PageApi`（onDirtyChange / registerApply）向 App 登记脏状态与 apply 句柄；脏页切换导航弹底部守卫条（保存并离开失败则留守，页内底栏显示错误）。
- **插件分页**：导航底部可展开「插件」组，每 companion 一个子页 = 启用开关（始终可配）+ 受控 SettingsCard（错误边界隔离：单卡崩溃只坏本页）。禁用插件仍在子导航（可重新启用）。
- **受控卡契约**（registry.ts）：`SettingsCard?: ComponentType<PluginSettingsCardProps>`（`{value, onChange}` 纯控制，卡内零网络）；`configStore?` 可选自有存储（physics：GET/PUT `/api/petween-physics/config`，同 hub 路由，overlay 侧传播故事不变；应用顺序 = 先存自有包再 PUT settings，验证拒绝先暴露、重试幂等）。
- **例外**：宠物页 iframe 保留 petween 编辑器自己的草稿+显式保存（本就是「显式应用」语义）；通用页无草稿项（自启即时生效，注明不经过「应用」）。
- 关窗 = hide：未应用草稿随窗口驻留内存，仅退出应用才丢（已知取舍，未做脏关窗确认）。

### 上游（petween-physics `760fb37`）

- PhysicsCard 可选受控模式：传 `value/onChange` 即纯控制（无 hub 读写/无防抖/无保存态行），不传保持 DSH 自治卡逐字节不变；§12 共享配置横幅在受控下经 onChange 合并（四组嵌套逐字段合并，镜像 store.update 语义）；恢复默认经 onChange。**4 个新受控用例，上游 194 全绿。**
- desktop 入口：`PluginSettingsCardProps` 结构镜像 + `configStore`（fetch 同源路由）。

### 测试（413 → 420，+7）

`tests/renderer/draft.test.ts`（node，4 用例：jsonDeepEqual 原始值/结构/数组/嵌套差异）；`tests/renderer/controlled-cards.test.tsx`（jsdom，3 用例：roamer/stats-hud 受控契约——渲染 value、经 onChange 报全包、**挂载零 fetch** 防自治保存回潮）。vitest include 扩到 `.test.tsx`。构建链（electron-vite build）验证设置窗 bundle 正常产出。

### 待用户真机验收清单

1. 导航：连接/宠物/交互/通用在顶部，插件组在最底部；点击展开三插件子项；子页各自独立。
2. 任意页改动 → 底栏亮「有未保存的更改」，取消回滚、应用落盘（overlay/托盘侧 3s 轮询内生效）；干净时按钮禁用。
3. 脏页切导航 → 守卫条三选项：留下（不动）/丢弃更改并离开/保存并离开（失败留守并显示错误）。
4. 插件子页：禁用状态下设置内容仍可见可改；启用开关随「应用」生效（关闭即时卸载）。
5. physics 页：改重力等参数 → 应用 → 拖甩手感随新配置（该页应用走 physics 自有路由）；「恢复默认」进草稿、点应用才落盘。
6. roamer/stats-hud 页改动随应用生效（3s 轮询热更新）；stats-hud 四类型样式选择等进草稿。
7. 连接页：连接器启用/跟随开关进草稿（应用后宠物联动启停）；安装/移除 hooks 与端口测试仍即时。
8. 关窗再开（hide→show）未应用草稿仍在；完全退出才丢弃。
9. 单卡崩溃隔离（可选用坏数据制造）不影响其他页。

### 后置项（backlog）

- 脏关窗确认（当前 hide 驻留即保留）；连接器 enable 的 hint 与实际延迟语义复查；roamer 卡密集行重排为正规 row 布局（借独立页空间，in-tree 无上游负担）；设置窗整体 e2e（Playwright 线）。

### 追记（2026-09-21 晚）：宠物编辑器保存文案对齐（上游 petween `11830e5`）

Phase 18 验收通过后用户追问：宠物页能否同样 取消/应用。核查结论——**编辑器 store 从设计起就是显式保存模型**（updateConfig 只进草稿 / saveConfig=应用 / revertConfig=取消），当时"绕圈"在 UI 呈现不在数据层；用户拍板先做**纯文案对齐**（行为零变化）：SaveIndicator 按钮固定为 应用/取消（原 保存到「name」/保存修改/撤回修改），目标宠物名挪到状态行「有未保存的更改（将应用到「name」）」；切换宠物门控提示写明出口「先『应用』或『取消』再切换」；revertConfig 三条 notice（取消失败/已中止取消/已取消未保存的更改）与 §3.3 门控、卡片提示、独立编辑器副标题同词表。「取消」保留确认弹窗（丢弃一大轮编辑比丢开关金贵）。上游 1111 测试全绿（断言同步更新）；桌面零代码改动，submodule 重建 editor.js + bump 指针即生效。**遗留**：脏时切换仍是"禁止 + 出口提示"而非三选——原语齐备，真觉得烦再升级。

### 追记（2026-09-21 深夜）：粒子特效扩容 + 音效插件化评估（上游 petween `84cebfe` / petween-physics `02b582a`）

**背景**：用户问「特效事件留的口有多大」。结论：容器通用（时间轴事件轨 + 播放路由 + 编辑器编排），内容闭环（事件类型枚举 2、特效枚举 3，扩枚举必须动上游，无装配缝；桌面无直发粒子的 API）。随后拍板扩特效本体。

**petween `84cebfe`（上游推送）**：特效表 3→6、形状 4→7——

- `heart-burst`：粉彩爱心（heart clip-path）+ 圆点，**负重力 -18 上浮**（spawn 数学 dy+gravity 天然支持，ParticleEffectSpec 注释补「负值合法=上浮」）；12 发。
- `petal-fall`：落樱椭圆（petal）+ 纸条，强下坠慢翻滚；14 发。
- `firework`：大半径混合爆发（dot/strip/ring），24 发（=单发上限）。
- 新形状：`heart`（polygon 裁剪）、`ring`（**唯一非填充形状**：透明底+30% 描边空心圆，styleParticle 加 ring 早退分支）、`petal`（0.75:1.7 椭圆）。

同步点三处：`ParticleEffectId` union / `PARTICLE_EFFECT_IDS`（验证器用）/ 编辑器下拉 `PARTICLE_EFFECT_OPTIONS`（爱心/落樱/烟花中文标签）。新增防漂移测试两条：渲染表 keys ↔ 枚举数组互查（particles.test + animation-definition.test 双侧）、验证器对全枚举逐 id 通过。motion-format.md 效果表与枚举行更新（implementation-notes 历史记录保持原样）。1111→1115 全绿；重建 editor.js。

**petween-physics `02b582a`（连带修复）**：bump petween 指针后桌面 typecheck 红——physics 镜像 `host/types.ts:46` events 硬编码三特效 union，真实服务 6 字面量后方法双变（bivariance）两条赋值路都断（镜像→真实本就断于 tracks.property，真实→镜像原靠枚举相等撑着）。按镜像文件头自己的兼容规则（「主插件扩契约 → 镜像跟进」）上游扩六字面量；physics 发送侧零变化（bounce 动画无事件）。194 全绿。

**桌面侧**：零代码改动即得六特效（渲染表数据驱动）；typecheck 干净、420 全绿，bump 双指针。真机验收：编辑器/编辑页给 transition 或 interaction 加粒子事件，下拉应有六项、新三特效正常发射（reduced-motion 或关 `advanced.particles` 时照旧不发射）。

**音效插件化评估（未实施，结论沉淀）**：**可行，V1 不必动上游**。桌面 companion 可用现有观察缝自建音效层——

- 逐事件时机：`subscribeAnimation` start 载荷带 `definitionId`（+source 归因 enter/interaction/external），从 host 动画库（local-server 已伺服，overlay 同源可取）拿完整定义，按 `event.at × durationMs` 自排 setTimeout 播音；settle('cancelled') 清定时器。
- 其余触发面：`subscribePose`（含 pose-swap 事件与 flash 的换图流）、`subscribeUserPointer`（点击/双击）、`subscribeStage`（状态机换态）——五类触发面全部现有 API 覆盖。
- 两个已知缺口：①循环动画的事件逐圈重放（timeline-scheduler 每圈 fireEvents，但 start 只发一次——音效需按 durationMs 自算圈次，random-interval 间隔拿不到）；②无逐事件观察流（拿到的是 start/settle 生命周期，不是事件本身）。上游若将来把 onEvent 扇出到 extension 面，两缺口一起闭，但 V1 音效（转场/交互/点击/换态配乐）用不到这两个角。
- 编辑器 scrub 预览（sampleTimelineAt）本就不回放粒子，音效同理——预览静默是既有语义。

## v0.8.0 里程碑评审（2026-09-21，六路子智能体综合评审）

范围：`58bc8fd..c759d0b`（Phase 17 roamer 四批 + Phase 18 设置窗重构 + 粒子/文案两 bump）+ 对应 submodule 变更（petween `8190ae6..11830e5`、petween-physics `0a83a24..760fb37`；v0.7.1/7.2 各自带过评审不重审）。六路：主进程 / 渲染-设置窗 / 渲染-roamer / 测试 / 文档 / 安全（roamer 是首次评审，渲染层拆两路）。

**结论：零 P0、6 P1 全修、12 项 P2 当场修或钉测，其余入 backlog。**

### P1（全部当场修复）

1. **apply 途中编辑被服务端回声吞掉**（设置窗路）：旧 useSettings 的 in-flight 合并保护在重写中丢失——PUT 在飞时的继续编辑会被 `setDraft(fresh)` 覆盖且 dirty 翻 false（守卫不再拦）。修复 = submitted 引用比对，编辑未落地时只更新 baseline 不动 draft（`page-draft.tsx`，钉测 `page-draft.test.tsx`）。
2. **「保存并离开」成功后 App.dirty 滞留 true**：页面卸载后无人上报 false，宠物/通用页此后每次导航弹假守卫、「保存并离开」静默不保存。修复 = 成功分支显式 `setDirty(false)`（与丢弃路径对齐）。
3. **ConnectBody 端口草稿不随「取消」回滚**：portDraft 只初始化一次，取消后输入框残留废弃值、blur 会复活已取消的编辑。修复 = 端口变化回同步 effect。
4. **RoamerCard.addImage 过期闭包**（设置窗/roamer/测试三路同报）：上传在飞时的其他编辑被旧 bag 整包回滚。修复 = bagRef 读最新包（钉测 = deferred fetch 竞态用例，含父组件回灌闭环）。
5. **Phase 18 保存模型零测试且入口文件不可 import**：main.tsx 顶层 createRoot 锁死可测性。修复 = 抽取 `page-draft.tsx` + 5 用例 hook 测试（装载/脏检/回滚/in-flight 存活/归一化采纳/退避重试）。
6. **companions per-id 合并无回归钉测**（v0.4.0 修过的 bug，Phase 18 把它变成每个插件页 apply 的热路径）：补 store 级钉测（兄弟插件 options/enabled 存活 + enabled-only patch 不动 options + per-id 整包替换）。

### P2（当场修/钉）

- 守卫条在页面变干净后不收起（渲染条件补 `&& dirty`）；physics apply 双出口非原子的已知取舍维持文档化（重试幂等）+ configStore.save 改为返回归一化结果（baseline 采纳服务端值而非信任 draft）；physics 400 诊断透出（configStore 读响应体 error.message，上游 `6e1ef02`）。
- roamer：拉窗顶部钳制改视口比例预算（CSS img ≤42vh/文本 ≤30vh 与 clampTop 同源，修低锚点出屏）；stage 事件可选 `now` 注入（引擎两处 Date.now() 收口）；leg-complete 投递 mischief 载荷前复查开关（用户刚关掉的效果不再落地）；内容池/姿势 URL 白名单 `/petween-assets/`（防恶意配置让 overlay 拉外网内容）；closeAll 死码删除。
- 安全：physics 写栅栏 `same-site` 短路放行对齐主插件语义（落穿 Origin↔Host 比对，上游 `6e1ef02` + 钉测——当前无浏览器可达写路径，属加固非堵洞）。
- 测试：受控卡「零 fetch」契约口径收窄（资产上传为明示例外）；addImage 竞态钉测转绿。

### 文档（当场修）

docs/02 拓扑行（设置窗自建页+iframe、animator 窗、companion 宿主、基线行）；docs/05 Phase 18 验收 ✅、Phase 17 测试数字（windows 6 用例、376→413）、后续增强 CC/Codex 划线、Phase 8 受控卡前向指针；AGENTS 决策速览刷新（见下）+ Phase 13/14 状态行 + 导读行；README 补设置模型与粒子六特效两特性。

### Backlog（评审产出，按价值排）

1. **roamer runtime（companion.ts）行为测试**——租约纪律/commit 次序/重闪还原/20s 兜底全住在零测试的那一半（评审给出四例设计：dispose×commit 交叠不双 release、abort 路径重闪、t≥1 先 apply、悬挂期新 walk 得 lease-denied）。
2. engine 补测：peek 三处中止复位、退化视口钳制、idle 完成同 tick fall-through、lease-denied 丢弃拉窗载荷。
3. tests 目录纳入 typecheck（tsconfig include）——.tsx 测试零类型检查的强转漂移风险。
4. roamer-assembly 逐条 catch（首条失败不中止剩余注册）；20s 超时竞速的 timer 不清除 nit。
5. 设置窗守卫条覆盖 iframe 脏状态（postMessage 桥）、脏关窗确认——Phase 18 后置项顺延。
6. 主进程路遗留：physics config hub overlay 侧一次性 memoized load 不轮询（Phase 8 起既有，重启才生效——「companion 重挂载预热」邻域）。

### 里程碑动作

P1×6 + P2×12 + 文档批全部当场修复；桌面 420→427 用例全绿（+7：page-draft 5 / per-id 合并钉测 1 / addImage 竞态 1；上游 petween-physics 194→195 含 same-site 钉测）；typecheck 与渲染构建全绿；打标签 v0.8.0。

### 2026-09-21（真机反馈批）：停留可配 + 窗口/便签样式重做 + 冲过/探头可见性

用户真机反馈三项：①窗口/便签停留时长要可设置（0.5s~60s，超 10s 给遮挡警告）；②便签图片被裁剪、两皮肤单调；③「冲过屏幕/探头窥视是什么效果？没看见变化」。修复：

1. **停留可配**：`mischief.pullLingerMs/noteLingerMs`（500..60000ms 钳制，默认 25s/45s——便签原 90s 超出用户定的上限故收窄）；runtime spawn 时透传，窗口层 `spec.lingerMs` 覆盖默认；设置卡秒为单位（step 0.5）+ 双值任一 >10s 时显示琥珀色遮挡警告行。
2. **样式重做**（windows.ts）：拉窗 = 标题栏（三色圆点 + 题注挪入栏内）+ 渐变底 + 深阴影；便签 = 顶部胶带（::before）+ 横线纸（文本）/白边拍立得（图片，`--has-image` 修饰类——旧 190px 皮 max-width 与 img 300px 打架导致**图片被裁**，根因 img 改 `width:100%` 随容器缩放）；**便签旋转改 `--pt-rot` CSS 变量进 pop 关键帧**——fill-mode both 会把 transform 永久钉在关键帧末值，内联 rotate 入场后即失效（真机上便签从未歪过的真因）。
3. **冲过/探头可见性**：两动作默认关（保守首发）+ 表现与普通走路无异是「没看见变化」的双重根因。dash：引擎 wander-start 新增 `gait:'dash'` 标记 → runtime 播专用冲刺步态（前倾 7~9° + 420ms 快摆 + 1.05~1.09 拉伸，loop）而非走路摆动；peek：倾身 44→76px + 旋转 7~8° 双峰张望，时长 2.6→3.2s。另：动作含义在交付说明中向用户解释（冲过=高速横穿屏幕、探头=走到边缘后探出头张望）。

428 用例全绿（+1：拉窗标题栏结构/便签拍立得类/自定义 linger 生效）；`user:roamer-dash` 随 ROAMER_ANIMATIONS 幂等注册。

### 2026-09-21（动作图片批）：九动作全量姿势覆盖 + 设置卡上传入口

用户问询「各个动作还不能配置宠子的图片吗」——引擎/存储自 Phase 17 起就支持 poses 覆盖但缺上传控件（backlog 项）。本批收口并把覆盖面从 3 行为扩到**全部 9 个动作**（走路/冲刺/打盹/张望/晃悠/抖毛/探头/拉窗/便签）：

- types `PoseOverrideKey` 扩九键；normalize 全键接受（同一本地资产 URL 白名单）。
- runtime：待机四动作全部 flashAsset 各自图（去掉 doze/lookAround 收窄）；冲刺腿 `poses.dash ?? poses.walk` 回落；peek 倾身期挂 `poses.peek`（holdMs 自还原——引擎 peek 复位无命令，无打断钩可挂）；拉窗/便签 spawn 时 1.2s「使劲/放置」闪光（同样自还原，短到不需要打断簿记）。
- 设置卡新增「动作图片」区（缩略图/上传/清除 per 动作，同一资产管道 + bagRef 纪律）；**置于内容池之后**——v0.8.0 的受控卡测试以「DOM 第一个 file input」为契约锚点，区序调换会静默改测的对象。
- 顺带修正 companion 描述文案（还停在「后续批次加入」）。

428 用例全绿（normalize 补 peek/note 键断言；零新文件）。
