# 桌面版目标架构与装配指南

> 基线：petween b0763e1（`vendor/petween` submodule）。本文回答「桌面壳怎么把 petween 装配起来」——所有 import 路径相对本仓库根，petween 源码在 `vendor/petween/src/` 下。

## 1. 进程与窗口拓扑

```
Electron app（单实例锁）
├─ main 进程（Node 24）
│   ├─ local-server.ts      # node:http，listen(0, '127.0.0.1') 随机端口
│   │   ├─ 装配 petween host（四 store + view-store + migrate-v2 + routes + state-channel + editor-page）
│   │   ├─ 伺服 overlay.html / 设置页（同源，petween client 的相对路径 fetch 零改动）
│   │   └─ SSE /api/petween/events 由 attachStateChannel 白拿
│   ├─ dsh-bridge.ts        # WS 客户端连 DSH，帧→RawSessionEvent→normalizeSessionEvent
│   ├─ overlay-window.ts    # 透明置顶全屏窗（setBounds 铺满，非 fullscreen）
│   ├─ settings-window.ts   # 普通窗口 loadURL('/petween-editor/')
│   ├─ pointer-through.ts   # setIgnoreMouseEvents forward + hit-test + 光标轮询兜底
│   └─ tray.ts / login-item.ts / displays.ts / updater.ts
├─ overlay 渲染进程          # Vite renderer，直接 mount PetOverlay（绕开 client/index.ts 的 slot 注册）
└─ preload                  # contextBridge 白名单 IPC（穿透切换通道、窗口控制）
```

### dev / prod 双模式（关键设计：全程同源）

petween client 侧全部 HTTP 是**根相对路径**（`client/api.ts`、`state-protocol.ts`），SSE 用原生 EventSource。为了保证「零改动 petween」，两个模式都必须让页面与 API 同源：

- **prod**：两个窗口都 `loadURL('http://127.0.0.1:<random>/...')`，local-server 同源伺服页面与 API。随机端口拼进 URL。
- **dev**：renderer 走 electron-vite dev server（HMR），在 `electron.vite.config.ts` 里配 `server.proxy`，把 `/api/petween`、`/petween-assets`、`/petween-editor` 代理到 main 的 local-server（dev 模式固定端口如 17777）。浏览器视角仍同源，SSE 走 http-proxy 正常流通。

## 2. Host 半装配清单（main 进程 deep import）

| 装配件 | 来源（`vendor/petween/src/`） | 备注 |
|---|---|---|
| `AnimationsStore` / `AnimationsStoreOptions` | `host/animations.ts` | 传 `animationsDir` |
| `AssetStore` / `AssetStoreOptions` | `host/assets.ts` | 传 `assetsDir` / `manifestPath` |
| `ConfigStore` / `ConfigStoreOptions` | `host/config.ts` | **务必显式传 `configPath`**，缺省会落到 `~/.dsh` |
| `PetsStore` / `PetsStoreOptions` | `host/pets.ts` | 传 `petsDir` |
| `createWriteLock` | `host/storage.ts` | 四 store 共享一把（对齐 `index.ts` 装配） |
| `ConfigViewStore` | `host/view-store.ts` | 预设权威化写协调器 |
| `buildConfigView` | `host/config-view.ts` | |
| `ensurePresetAuthority(root)` | `host/migrate-v2.ts` | **建 store 前先跑**，与 `index.ts` 同顺序 |
| `migrateLegacyHome(from, to)` | `host/migrate.ts` | 可选：从 `~/.dsh/petween` 一次性导入 |
| `registerRoutes(host, deps)` | `host/routes.ts` | `RoutesDeps` 是 20 个函数的纯注入结构；**装配范本 = `index.ts:57-99`** |
| `RoutesHost` 适配器 | 自写 ~30-50 行 | exact 优先 / prefix 最长匹配的 node:http 分发；**参考实现 = petween `tests/host/routes.test.ts:80-120`** |
| `attachStateChannel(host, opts?)` | `host/state-channel.ts` | 桥实现 `StateChannelHost` 的 4 个 `on()`；SSE/心跳/快照端点白拿 |
| `planMotionPackImport` 等 | `host/packs.ts` | `RoutesDeps.importPack` 用 |
| `registerEditorPage(host, deps?)` | `host/editor-page.ts` | **必须注入 `loadBundle: () => readFile('<petween>/lib/editor.js')`**——默认按 `import.meta.url` 找包，deep import 态会 404 |
| `createPetweenHostService(store)` | `host/service.ts` | 桌面版无伴生插件，可跳过 |
| `normalizeSessionEvent` / `normalizeAgentStatus` / `normalizeAgentError` | `integration/dsh/event-normalizer.ts` | 桥的输出端 |

## 3. Client 半装配清单（overlay 窗口）

| 装配件 | 来源 | 备注 |
|---|---|---|
| `PetOverlay` | `vendor/petween/src/client/overlay/PetOverlay.tsx` | 纯组件（props.hub?），无 slots/cordis |
| `PetRenderer` / `PetStage` | `client/overlay/` | `position:fixed` + `pointer-events` 契约与透明窗口天然契合 |
| `OverlaySession` + Options | `client/overlay-session.ts` | `createStateSource` 是注入点（默认 DshStateSource 走 SSE，桌面版直接用默认） |
| `configHub` / `ConfigHub` | `client/config-hub.ts` | same-origin fetch + 3s 轮询 |
| `DshStateSource` / `installCurrentSessionSource` | `integration/dsh/dsh-state-source.ts` | **MVP 用 aggregate 模式**（不装 CurrentSessionSource，自动落到全 session 聚合 SSE——这是 petween 已支持的 §14.5 fallback）；「跟随 DSH 当前会话」记为后续增强 |
| `StateAdapter` / state-protocol | `integration/dsh/` | 纯 TS，EventSource + 2s 轮询降级 |
| 设置编辑器整页 | `lib/editor.js`（构建产物） | 设置窗口 `loadURL('http://127.0.0.1:<port>/petween-editor/')`，零代码复用 |

新写的 overlay 入口约 50 行：创建 React root → `configHub` → mount `<PetOverlay />`。**不要 import `vendor/petween/src/client/index.ts`**（那是 DSH slot 注册）。

## 4. 数据目录决策（推荐，可拍板）

桌面版默认**独立数据目录**：`app.getPath('userData')/petween-home/`（结构对齐 `$DSH_HOME/petween/`）。理由：DSH 插件版与桌面版可能同时运行，共享 `~/.dsh/petween` 会变成双实例写同一 config（跨进程 WriteLock 防撕裂但语义混乱）。首次启动提供「从 DSH 导入」（复用 `migrateLegacyHome`，用户主动触发）。

## 5. 工程边界与工具链

- **脚手架**：electron-vite（stable 5.x / Vite 7）三段式 main / preload / renderer；Electron 44.x（Node 24.20 / Chromium 152）。
- **tsconfig 对齐四项**（否则编译 petween 源码报错）：`moduleResolution: "bundler"`（相对导入无扩展名）、`jsx: "react-jsx"`、`lib/target ≥ ES2022 建议 ES2024`、`strict`（源码本就 strict）。main 侧加 `"types": ["node"]`。不要开 petween 没开的高严格项（如 `noUnusedLocals`）。
- **petween 引用方式**：`package.json` 里 `"petween": "link:./vendor/petween"`，Vite/electron-vite 按 bundler 解析直接吃 TS 源码；或 `resolve.alias` 直指 `vendor/petween/src`。
- **桌面壳必须自己声明的依赖**：运行时 `@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-atomic-write`、`fflate`、`ws`、`react`/`react-dom`；仅类型 `@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-session`、`@types/react ~18.3`。
- **已知坑**：petween 仓库的 node_modules 符号链接因历史目录搬迁已断（指向旧路径 `D:\Documents\JustAnotherPetPlugin\...`），联调前必须在 `vendor/petween` 里重跑 `pnpm install` 修复，否则 bundler 解析不到 `dsh-home-paths` 等包。
- **测试**：main 薄壳化——Electron API 调用收敛到少数模块，业务逻辑（bounds 计算、端口编排、hit-test 几何、退避参数）写纯函数，vitest `environment: 'node'` + `vi.mock('electron')` 直测；渲染栈沿用 petween 既有 jsdom + mocked `element.animate` 模式；Playwright `_electron.launch` 做少量冒烟。回归护栏 = 在 `vendor/petween` 里跑 `pnpm test`。

## 6. petween 侧可选补丁清单（MVP 均可不做；做则回流上游）

1. **P0（强烈建议）**：`dependencies` 补 `@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-atomic-write`、`fflate`（现状埋在 devDeps，第三方装包跑不起来）。
2. **P1**：exports 增补 `"./host"` 装配桶（或 tsdown 多打 host-core ESM bundle）+ `"./editor-bundle": "./lib/editor.js"`。
3. **P2**：`files` 加 `src/`（npm 消费 deep import 通道；file:/link: 不受影响）。
4. **P3（可选）**：`client` 侧 `./client/overlay` 纯组件 ESM 入口（免 `__ModuleLoader__` 包裹）；`editor-page.ts` 默认 `loadBundle` 加向上回退查找。

## 7. 构建依赖顺序

设置页依赖 `vendor/petween/lib/editor.js`（构建产物）——完整构建链：

```
vendor/petween: pnpm install && pnpm run build   # 产出 lib/editor.js 等
petween-desktop: pnpm install && pnpm run build  # electron-vite 三段式 + electron-builder
```

overlay 的 renderer 走 Vite 直吃 `vendor/petween/src/`（TS 源码），不依赖 petween 构建产物；只有设置页需要 editor.js。
