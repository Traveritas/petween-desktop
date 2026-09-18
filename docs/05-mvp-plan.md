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

1. **连接器**：~~zcode~~（✅ 2026-09-18 Phase 9 落地，见下文与 docs/06；架构与传输家族就此定型——curl cfg 端口发现 + 合并安装 + watchdog 模板）→ Claude Code（2026-09-14 已调研：hooks http handler，6/6 状态显式覆盖；hooks 面与 zcode 同构，可复用大半）→ opencode（SSE，状态枚举近 1:1）→ Codex/Gemini/Cursor
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
- [x] 全量回归：壳层用例（Phase 8 时 78，里程碑评审后 89）+ physics 上游 166 用例 + petween 基线 1044 用例全绿
- [ ] 投掷手感参数微调（用户日常使用中按需调 PhysicsCard 参数）

**实施记录（含一次事故）**：
- **2026-09-16 鼠标卡死事故**：调试期间把模式切到 always-interactive 且被持久化 → 整屏窗吃掉系统所有鼠标点击（键盘不受影响，overlay focusable:false）；救援热键 Ctrl+Alt+P 被占用注册失败 → 无逃生口。**用户拍板：该模式整体移除**（与救援热键的瞬时锁定功能重叠且是唯一能卡死鼠标的路径）；救援热键改为链式注册（Ctrl+Alt+P→I→U）。任何残留的 always-interactive 设置值归一化为 auto。
- **坐标空间教训**：本机 2560×1600@100%，overlay CSS 视口 = 2560×1600；computer-use 截图 raster 是半采样（1280×800）——换算 raster×2=CSS。给视觉模型喂先验坐标会得到顺从性误判（报错误位置"确认存在"），验收要以 config overlay 值/bodyRect 等数据源为准。
- **排查顺带证实**：穿透三通道（转发 hit-test/光标轮询/滞回）在真实数据下判定全部正确。
- **待办**：`dist:win` 前需在 electron-builder.yml files 加 `!node_modules/petween-physics`（防止 link 跟进 submodule）；dev 长会话中 main 热重启监视器偶发失灵（重启 dev 即恢复，低优先级记录）。


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
3. electron-builder 下载（Electron zip 等）不走系统代理，需 `HTTPS_PROXY=http://127.0.0.1:7897 pnpm run dist:win`（Clash 混合端口）。

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

## Phase 10：统计泡泡 HUD（思考用时 / 编辑行数）（2026-09-18 代码完成；真机验收待用户重装 hooks + 重启 zcode）

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
- [ ] 真机：设置→连接→zcode「重装 hooks」→**重启 zcode 客户端**（hooks 启动时读）→ 跑一次编辑任务，观察泡泡（思考计时/行数累加/淡出/样式切换）
- [ ] 旧格式 hooks（未重装）期间一切照旧（宠物联动不断，只是无泡泡）

### 后置项（重开触发器）

多会话泡泡动态排布（多列/避让策略）、完成提醒泡泡、对话泡泡（独立 companion，复用 BubbleHost；数据走 transcript 尾读）、里程碑触发宠物本体动画（`playAnimation` 接口已通）。

## 待用户拍板项

- [ ] publish 目标仓库与发版流程（appId 已在 electron-builder.yml 定为 `com.traveritas.petween`，仅发布仓库待定）
- [ ] 数据目录策略确认：独立 `userData/petween-home/` + 一次性从 `~/.dsh/petween` 导入（02 号文档 §4 的推荐）
- [ ] 是否需要 macOS 支持（穿透/托盘 API 有平台差异，MVP 只验 Windows）
