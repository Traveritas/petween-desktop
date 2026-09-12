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

## Phase 5：系统集成

- [ ] 单实例锁 + `second-instance` 唤起设置窗
- [ ] 托盘：打开设置 / 退出 / DSH 连接状态显示 / 开机自启勾选（**开/关用完全相同 path/args**，04 号文档 §4）
- [ ] settings 窗口 close→hide；`window-all-closed` 不退出
- [ ] `display-metrics-changed` / 分辨率变化重新铺满
- [ ] （可选）「从 DSH 导入数据」菜单项：`migrateLegacyHome(~/.dsh/petween → userData)`

**验收**：二次启动唤起设置窗；开机自启勾选后重启系统生效（路径含空格用户名场景测试或至少代码审查确认引号处理）；托盘退出干净（无残留进程/宠物窗）。

## Phase 6：构建分发

- [ ] electron-builder + NSIS（04 号文档 §5 配置）+ asar + files 白名单
- [ ] `vendor/petween/lib/editor.js` 进包（构建脚本里先构建 submodule 或 vendor 产物提交策略——二选一，写明）
- [ ] GitHub Releases + electron-updater（更新前 flush 在途保存）
- [ ] README：安装说明 + **SmartScreen「更多信息→仍要运行」说明**
- [ ] Playwright `_electron.launch` 冒烟：窗口数、托盘存在、设置页可开

**验收**：干净 Windows 机器（或新用户目录）安装→首跑→全功能可用；卸载无残留启动项。

## 后续增强（MVP 后，按价值排序）

1. petween 侧 P0-P2 补丁回流（`dependencies` 声明、`./host` 装配桶 exports——见 02 号文档 §6）
2. 「跟随 DSH 当前会话」状态源（替代 aggregate）
3. petween-physics 移植：`petween/client` 扩展服务改进程内直连暴露（接口本体 cordis-free 可平移）；ThrowController 视口从「DSH 网页视口」参数化到「OS 屏幕边界」
4. 多显示器每屏一窗
5. 其他 agent 状态源（Claude Code hooks 等）——桥是可插拔的，这是「通用 Agent 桌宠」方向
6. 动态 `setShape` 备用穿透方案

## 待用户拍板项

- [ ] GitHub 仓库名 / appId（`com.traveritas.petween`?）与 publish 目标仓库
- [ ] 数据目录策略确认：独立 `userData/petween-home/` + 一次性从 `~/.dsh/petween` 导入（02 号文档 §4 的推荐）
- [ ] 是否需要 macOS 支持（穿透/托盘 API 有平台差异，MVP 只验 Windows）
