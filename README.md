# Petween Desktop

Petween 的独立 Windows 桌面版：把 [petween](https://github.com/Traveritas/petween)（DeepSeek Harness 桌宠动画中间件插件）以零改动装配级复用装进 Electron——透明置顶窗口里的桌宠 + 独立设置编辑器 + 本地 DSH 会话事件桥。

- 宠物联动本地 DSH（`dsh web`）的 agent 状态：思考 / 工作 / 等待审批 / 成功 / 出错；DSH 未运行时为纯装饰模式。
- 与 DSH 插件形态共享同一份 core（git submodule 单一上游），配置/宠物/动画/资产数据模型完全一致，支持从 `~/.dsh/petween` 一次性导入（托盘菜单 →「从 DSH 导入数据…」）。
- 桌宠窗口透明置顶、点击穿透（宠物本体之外的区域完全放行鼠标）；救援热键兜底；托盘常驻，二次启动唤起设置窗口。
- 投掷物理伴生插件：拖住宠物甩出，重力下落与屏幕边缘弹跳（设置 → 插件 可调参数/启停）。

## 状态

✅ v0.1.0（2026-09-16）：Phase 0~8 全部完成并通过真机验收——含桌面设置窗口（连接/宠物/交互/插件/通用）、点击穿透三通道与救援热键、DSH 状态桥（真机联测通过）、以及伴生插件体系与首个伴生「投掷物理」（拖住宠物甩出：重力 + 屏幕边缘弹跳 + 撞击特效）。发布项待拍板——见下。

- 可行性结论与风险：[docs/01-eval.md](docs/01-eval.md)
- 架构与装配指南：[docs/02-architecture.md](docs/02-architecture.md)
- DSH 状态桥规格：[docs/03-dsh-bridge-spec.md](docs/03-dsh-bridge-spec.md)
- Electron 技术要点：[docs/04-electron-notes.md](docs/04-electron-notes.md)
- **实施计划（当前进度）：[docs/05-mvp-plan.md](docs/05-mvp-plan.md)**

## 安装（Windows）

1. 从 Releases 下载安装包并运行（NSIS 安装器，可选安装目录）。
2. 首次运行会出现在系统托盘（洋红圆点图标）——右键托盘图标：打开设置、开机自启、从 DSH 导入数据、退出。
3. 设置窗口里导入至少一张图片（推荐透明背景 PNG/WebP）作为「待机」姿势，宠物即出现在桌面上。

> ⚠️ 安装包未做代码签名：Windows 首次运行可能弹出 SmartScreen「Windows 已保护你的电脑」，选择「更多信息 → 仍要运行」。

> DSH 联动：需要本地 `dsh web` 在跑（默认端口 3080，可用环境变量 `PETWEEN_DSH_PORT` 覆盖）。DSH 不在时宠物保持待机，不影响其他功能。

## 开发

```bash
git clone --recurse-submodules <this-repo>
cd vendor/petween && pnpm install && pnpm run build && pnpm vitest run
cd ../.. && pnpm install && pnpm dev
```

- `pnpm test`：壳层单测（89 用例，不启动 Electron）
- `pnpm typecheck`：tsc 全量（含 petween 源码）
- `pnpm dist:win`：构建 submodule → electron-vite 三段构建 → electron-builder（NSIS + 便携版 `dist/win-unpacked/Petween.exe`）

> pnpm 10 会拦截依赖构建脚本，本仓库已通过 `pnpm.onlyBuiltDependencies` 白名单放行 electron/esbuild；Electron 二进制缺失时跑 `node node_modules/electron/install.js`。

## 许可

MIT（与 petween / petween-physics 一致）。
