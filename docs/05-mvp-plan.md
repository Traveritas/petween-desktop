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

## Phase 3：点击穿透

- [ ] `pointer-through.ts`：默认 `setIgnoreMouseEvents(true, {forward:true})` + renderer mousemove hit-test 切换（IPC 通道经 preload 白名单）
- [ ] hit-test 数据源：优先复用 petween StageSnapshot 的 `bodyRect`（extension-surface 已暴露），否则 `document.elementsFromPoint`
- [ ] **光标轮询兜底**（必须）：main `screen.getCursorScreenPoint()` 200~500ms 轮询 + 渲染层定期上报包围盒（04 号文档 §2 坑 1——焦点在别的 App 时转发停摆）
- [ ] 4~8px 滞回余量防抖动；`did-finish-load` 后重新 apply 转发；DevTools 打开时告警提示
- [ ] 拖动与穿透的交互语义实测：穿透态下鼠标扫过宠物应恢复可点；拖动中不穿透

**验收（人工 checklist）**：① 宠物矩形外点击完全落到下层窗口/桌面；② 悬停宠物出现 hover、单击触发交互；③ 在别的应用全屏工作时宠物仍可点/可拖（#33281 场景）；④ 任务栏可见且不被宠物窗遮挡交互；⑤ 拖动流畅无抖动。**必须关掉 DevTools 测。**

## Phase 4：DSH 状态桥

- [ ] `src/main/dsh-bridge/`：按 03 号文档实现——两条 WS（mux + host，**必须双流**）+ 帧解包（server-request 信封）+ 9 条契约转换 + `StateChannelHost` 适配器接到 attachStateChannel
- [ ] 连接生命周期：官方参数退避（500ms 基数 ×2 至 10s 带抖动、3s 开流握手）、`ws.ping()` 20-30s 心跳 2 次无 pong 判死、重连后 subscribed 集对照清差集
- [ ] 端口发现：设置项 → 默认 3080 → 探活 `POST /api/host.describe`
- [ ] 降级：DSH 不在时退避循环不产事件（宠物保持 idle 纯装饰）；托盘菜单显示连接状态
- [ ] 状态源：MVP 用 **aggregate 模式**（不装 CurrentSessionSource，petween §14.5 fallback 自动生效）；「跟随 DSH 当前会话」记为后续增强
- [ ] 单测：帧转换纯函数逐条对照 03 号文档 §7 的 9 条转换；用录制帧 fixture 驱动桥的有限状态机（连接/重连/清差集）

**验收（真机）**：`dsh web` 在跑时，DSH 里发起一个任务：思考→宠物 thinking、工具调用→tool 状态、完成→success→回 idle；等待审批→waiting；DSH 重启→宠物回 idle 无残留状态；杀掉 DSH→退避重连日志正常、宠物持续可交互。

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
