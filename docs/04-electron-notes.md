# Electron 壳技术要点（2026-09 核实）

> 由子智能体经 Web 核实（Electron 当前 stable **44.x**，Chromium 152 / Node 24.20，支持线 42/43/44；44 线 EOL 2027-03）。Windows 10/11 为主。实现壳时逐节对照。

## 1. 透明置顶全屏窗口

**推荐**：单显示器 V1 用主显示器全屏透明窗；多显示器「每显示器一窗」；**永远不用 fullscreen/maximize，用 `setBounds(display.bounds)` 铺满**。

```js
new BrowserWindow({
  transparent: true, frame: false, resizable: false,   // transparent 窗口 resizable:true 可能直接破坏透明
  show: false,                                          // + ready-to-show 再 show，避免启动白/黑闪
  backgroundColor: '#00000000',
  skipTaskbar: true,
  focusable: false,                                     // 防抢焦点（配合 §2 动态恢复交互）
  hasShadow: false,
  fullscreenable: false,                                // 不走系统全屏路径
  webPreferences: { backgroundThrottling: false, preload, sandbox: true, contextIsolation: true }
})
win.setAlwaysOnTop(true, 'screen-saver')   // pop-up-menu 及以上在 Windows 位于任务栏之上；默认 floating 在任务栏之下
win.setBounds(display.bounds)              // 铺满该显示器（DIP 坐标）
```

已知坑：
- 透明窗口不能最大化/全屏（Windows 官方限制），社区一律 setBounds 铺满。
- **DevTools 打开时窗口不再透明**——调试穿透必须关/分离 DevTools 再测。
- **多显示器**：每显示器一窗优于单窗跨屏（混合 DPI 下跨屏窗口必然错位）。随之而来的是跨窗口宠物状态归属——本项目的约束是「宠物逻辑驻留 main/单一状态源，各 overlay 窗只是渲染面」，petween 的 config/位置模型天然单宠物，MVP 可只做活跃显示器单窗。
- **DPI（125%/150%）**：Electron 全部坐标 API 是 DIP，`display.bounds` 铺满后 `innerWidth === bounds.width`，与缩放无关；坑只在 DIP 与物理像素混算（截图、第三方库）。监听 `display-metrics-changed` 重新 setBounds。
- **GPU 合成**：个别机器硬件加速下透明失效显黑/灰底（electron#40515、#2170），但**盲目 `disableHardwareAcceleration()` 反而破坏穿透**（#48064）——默认保持硬件加速，留命令行兜底开关。

## 2. 点击穿透（本项目最高风险点）

**推荐**：官方「forward + hit-test」为主，main 进程光标轮询兜底加固。

```js
// main：默认穿透但转发 mousemove
win.setIgnoreMouseEvents(true, { forward: true })
ipcMain.on('set-ignore-mouse-events', (e, ignore, opts) =>
  BrowserWindow.fromWebContents(e.sender)?.setIgnoreMouseEvents(ignore, opts))
// renderer：mousemove 对宠物包围盒 hit-test（document.elementsFromPoint 或矩形判定）→ 切换穿透/可交互
```

已知坑（按优先级）：
1. **焦点在特定非 Electron 窗口时转发停止**（electron#33281）——桌宠核心场景恰是重灾区。**兜底必须做**：main 进程 `screen.getCursorScreenPoint()` 轮询（200~500ms）+ 渲染层定期上报宠物包围盒（petween 的 StageSnapshot 已含 `bodyRect`，extension-surface 的快照流可以直接复用），命中矩形时 `setIgnoreMouseEvents(false)`，不依赖转发事件。
2. **页面 reload 后转发失效**（#15376）——`did-finish-load` 后重新 apply。
3. **forward 会干扰其他窗口拖拽**（#35030）——设置窗口 `will-move`/`will-resize` 期间临时关闭转发。
4. **切换抖动**：包围盒边缘反复切换，加 4~8px 滞回（hysteresis）余量。
5. Linux 有 43.2.0+ 的 `setIgnoreMouseEvents` 完全失效回归（#52456，X11）——本项目只做 Windows 不受影响，跨平台前需知。

替代方案：`win.setShape(rects)`（Windows/Linux，**Experimental**）——系统级可交互区域，区域外事件落穿且不绘制；形状随宠物移动要高频更新、区域外连 hover 都没有。留作疑难机器备用。

## 3. 进程结构

**推荐**：main 直接 require 现有 Node 代码（Electron main 就是完整 Node 24，node:http + ws 零改动）；两个窗口 `loadURL('http://127.0.0.1:<port>/...')`，同源方案。

- 服务只绑 `127.0.0.1`；**随机端口**：`server.listen(0, '127.0.0.1')` 后取 `server.address().port` 拼进窗口 URL。可选加固：URL 带一次性 token + 服务校验，防本机其他进程探测。
- 同源 HTTP 的优势：CSP 走响应头（file:// 只能 meta 标签）；页面与 `/api/*` 同端口无 CORS；`http://127.0.0.1` 是 potentially trustworthy origin，无混合内容问题。
- CSP 注意：`connect-src` **不会**自动放行 localhost 不同端口，要显式列；同源 `'self'` 即覆盖。
- **绝不关 `webSecurity`**。
- asar：Electron 给 fs 打了补丁，main 里的 http server 从 asar 内 serve 静态文件开箱即用。
- dev 模式（见 02 号文档 §1）：electron-vite dev server + `server.proxy` 代理 `/api/petween`、`/petween-assets`、`/petween-editor` 到 main 的 local-server（dev 固定端口），保同源 + HMR。

## 4. 生命周期与系统集成

- **单实例**：`app.requestSingleInstanceLock()` 失败即 `app.quit()`；`second-instance` 里 `settingsWindow.show()`。
- `window-all-closed` 里**不退出**（默认行为会退）。
- **托盘**：`new Tray(nativeImage)` + `setContextMenu`（打开设置 / 切换宠物 / 开机自启勾选 / 退出）+ `setToolTip`；**Tray 实例必须挂全局引用**否则被 GC 图标消失；托盘点击时 `setImage` 刷新可兜底 Explorer 重启个案。
- **退出语义**：托盘「退出」设 flag 再 `app.quit()`；settings 窗口 close → hide（不退出）。
- **开机自启**：`app.setLoginItemSettings`，electron-builder NSIS 下**直接用 `process.execPath`，不要 Update.exe 模式**（那是 Squirrel.Windows 专属）。坑：未加引号的 Run 路径已由 CVE-2026-34768 修复（38.8.6+，用 44.x 天然免疫），中文路径无碍、**含空格才是坑**；开/关必须用**完全相同的** path/args 字符串（不一致会被当成新 Run 键，getLoginItemSettings 误报）；卸载钩子里清一次启动项更稳。

## 5. 构建与分发

**推荐**：**electron-builder + NSIS + GitHub Releases + electron-updater**（2026 社区共识：Forge 是官方铺装路适合要默认值的新手；builder 定制与自动更新链路更成熟，electron-vite 生态大量配 builder）。

```yaml
appId: <tbd>
productName: Petween            # 避免空格
nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false }
compression: maximum
publish: { provider: github, owner: Traveritas, repo: <tbd> }
```

- 自动更新最小配置：runtime dep `electron-updater` + builder `publish.provider: github` + main 里 `autoUpdater.checkForUpdatesAndNotify()`；发布时 `latest.yml`、exe、blockmap 传 GitHub Release assets。坑：更新前确认无在途写入、退出前 flush（petween 的保存是 debounce 的，要复用 physics 卡片已有的 unmount flush 模式）。
- **无签名 SmartScreen**（微软官方 reputation 文档）：未签名文件**每个新版本都要重新积累信誉**，每次发版首跑都弹「Windows 已保护你的电脑」，用户需「更多信息 → 仍要运行」。README 如实写明；长期解法 OV/EV 证书。
- 体积地板价 ~50-100MB 安装包 / 85-240MB 装后（Chromium+Node 占大头）；优化只有 compression maximum + files 白名单裁剪 + 去无用 locale；asar 默认开启保持。

## 6. 工程脚手架

- **electron-vite**（活跃维护：stable 5.0 配 Vite 7；Forge 的 plugin-vite 还停在 Vite 7），开箱解决 main（CJS/ESM 出包 + 依赖 externalize）/ preload / renderer 三段构建、renderer HMR、main 热重启。
- 共享 TS 源码：`resolve.alias` 直指 `vendor/petween/src/*.ts`（Vite 按 bundler 解析直接吃 TS 源码，无需先 tsc 出 dts）；main 侧由 electron-vite 打进产物，无运行时解析问题。
- **Electron 版本 44.x**（Node 24.20 / Chromium 152）——main 里现有 Node 代码语义对齐 Node 24，比 DSH 环境只新不旧。

## 7. 测试

- 单元测试**绝不启动 Electron**：`environment: 'node'` + `vi.mock('electron', () => ({...}))` 工厂式 mock（`vi.doMock` 有 mock 全 undefined 的坑，勿用）。
- **架构前提**：main 薄壳化——窗口创建/托盘/Electron API 调用收敛到少数模块；业务逻辑（bounds 计算、login-item 参数映射、端口编排、hit-test 几何、退避参数）写成纯函数注入式，Node 下直测。
- 渲染进程：petween 现有 React + WAAPI 栈本就不依赖 Electron，jsdom + mocked `element.animate` 的既有 vitest 模式原样继续——**测试面几乎零迁移，这是这套架构的最大红利**。
- IPC 契约：mock `ipcMain`/`contextBridge` 锁 channel 名与 payload 形状。
- E2E（少量冒烟）：Playwright `_electron.launch` 起真实例，断言窗口数/托盘存在/设置页可开；**透明与穿透的视觉效果保留人工 checklist**。

## 8. 最小可信壳文件结构（规划期草图——实际模块见 src/，含 desktop-settings/desktop-routes/pointer-through-*/companions/physics-assembly 等）

```
petween-desktop/
├── package.json
├── electron.vite.config.ts        # main / preload / renderer 三段 + alias 指 vendor/petween/src + dev proxy
├── electron-builder.yml
├── resources/tray.png             # 16/32px 及 @2x
├── src/
│   ├── main/
│   │   ├── index.ts               # 单实例锁、app 生命周期、服务→窗口编排
│   │   ├── local-server.ts        # node:http + petween host 装配（02 号文档 §2）
│   │   ├── dsh-bridge/            # 状态桥（03 号文档）
│   │   ├── overlay-window.ts      # 透明置顶窗（本文件 §1）
│   │   ├── settings-window.ts
│   │   ├── pointer-through.ts     # 穿透切换 + 光标轮询兜底 + 滞回（本文件 §2）
│   │   ├── tray.ts / login-item.ts / displays.ts / updater.ts
│   ├── preload/index.ts           # contextBridge 白名单 API
│   └── renderer/
│       ├── overlay/               # mount PetOverlay（02 号文档 §3）
│       └── (设置页直接用 host 伺服的 /petween-editor/，无需自建 renderer)
└── tests/main/                    # vitest node 环境 + vi.mock('electron')
```

devDeps：`electron@^44`、`electron-vite@^5`、`electron-builder`、`typescript`、`vitest`、`@playwright/test`（可选）。runtime deps：`ws`、`electron-updater`（发自动更新才需要）+ 02 号文档 §5 列的 petween 连带依赖。

## 三个最高风险点（重申）

1. **#33281 焦点丢失致转发停摆**——光标轮询兜底必须做，不做则「用户在别的 App 工作时宠物不可交互/拖不动」。
2. **透明窗口与 GPU 合成的机型差异**（#40515/#48064 组合）——保留开关但默认开硬件加速。
3. **无签名 SmartScreen**——发版说明写清「更多信息→仍要运行」，避免用户误报「病毒」。
