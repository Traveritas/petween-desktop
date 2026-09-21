# Petween Desktop

[![CI](https://github.com/Traveritas/petween-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/Traveritas/petween-desktop/actions/workflows/ci.yml)

Petween 的独立 Windows 桌面版：把 [petween](https://github.com/Traveritas/petween)（桌宠动画中间件）以零改动装配级复用装进 Electron——透明置顶窗口里的桌宠，**实时联动你正在用的 AI 编码代理**。

## 它能做什么

- **宠物读心**：zcode / Claude Code / OpenAI Codex 三个连接器（同一 hook 引擎）把 agent 会话状态实时映射到宠物表情——思考 / 写代码 / 跑命令 / 等授权 / 回合成功 / 出错，也支持 DeepSeek Harness（`dsh web`）状态桥。什么都不开时就是一只安静的桌宠。
- **统计泡泡 HUD**：思考用时、编辑行数（实时累加）、模型回复摘要、完成摘要四类泡泡浮在宠物旁；7 种皮肤、入场/出场动画独立可配。
- **桌宠交互**：透明置顶 + 点击穿透（三态机，宠物之外的区域完全放行鼠标）、拖拽、救援热键兜底、托盘常驻。
- **投掷物理**：拖住宠物甩出去——重力、屏幕边缘弹跳、按图片可见像素的碰撞箱。
- **自主行为**：闲时（或永远）宠物自己在桌面上游荡、打盹/张望/抖毛等待机小动作，还会捣乱——从屏幕边缘拉出你自定义内容池的窗口、贴便签、冲过屏幕、探头窥视；三类行为的每个子项都可独立开关。
- **动画编辑器**：独立三栏工作台窗口（时间轴 scrub/缩放、多选、undo、bezier 曲线），与 DSH 插件形态共享同一份动画数据模型；动画可挂粒子特效（六种：爆裂/爱心上浮/落樱/烟花等）。
- **设置体验**：插件分页（每个插件独立设置页，禁用态也能先配置），Windows 属性对话框式的每页 取消/应用 + 未保存离开守卫。
- **数据互通**：与 DSH 插件形态共享同一 core（git submodule 单一上游），支持从 `~/.dsh/petween` 一次性导入。

## 状态与进度

✅ 三连接器（zcode / Claude Code / Codex）全部真机验收通过。当前版本、测试基线与 Phase 进度以 [docs/05](docs/05-mvp-plan.md)（执行入口）为准。

| 文档 | 内容 |
|---|---|
| [docs/01-eval.md](docs/01-eval.md) | 可行性评估总报告 |
| [docs/02-architecture.md](docs/02-architecture.md) | 目标架构与装配指南 |
| [docs/03-dsh-bridge-spec.md](docs/03-dsh-bridge-spec.md) | DSH 状态桥规格 |
| [docs/04-electron-notes.md](docs/04-electron-notes.md) | Electron 技术要点（含已知坑位） |
| [docs/05-mvp-plan.md](docs/05-mvp-plan.md) | **执行入口：Phase 进度 + 里程碑评审** |
| [docs/06-zcode-connector.md](docs/06-zcode-connector.md) | zcode 连接器规格（连接器架构模板） |
| [docs/07-cc-connector.md](docs/07-cc-connector.md) | Claude Code 连接器规格 |
| [docs/08-codex-connector.md](docs/08-codex-connector.md) | Codex 连接器规格 |

## 安装（仅 Windows）

1. 本地构建：`pnpm dist:win` 产出 NSIS 安装器 + 便携版（暂不发布公开 Releases）。
2. 首次运行出现在系统托盘——右键托盘：打开设置、开机自启、从 DSH 导入数据、退出。
3. 设置窗口导入至少一张图片（推荐透明背景 PNG/WebP）作为「待机」姿势，宠物即出现。
4. 想要 agent 联动：设置 → 连接 → 对应卡片点「安装 hooks」（zcode 需重启客户端；CC 热加载；Codex 需系统 Node.js 并确认一次信任）。

> ⚠️ 安装包未做代码签名：Windows 首次运行可能弹 SmartScreen，选「更多信息 → 仍要运行」。

## 开发

前置：**Windows 10+**（穿透与打包链是 Windows 实证的）、**Node.js ≥ 20**（24 已验证）、**pnpm 10**。

```bash
git clone --recurse-submodules <this-repo>
cd vendor/petween && pnpm install && pnpm run build && pnpm vitest run
cd ../.. && pnpm install && pnpm dev
```

- `pnpm test`：壳层测试套件（不启动 Electron，CI 同款）
- `pnpm typecheck`：tsc 全量（含 petween 源码）
- `pnpm dist:win`：构建 submodule → electron-vite 三段构建 → electron-builder（NSIS + 便携版）

> pnpm 10 拦截依赖构建脚本，本仓库已通过 `pnpm.onlyBuiltDependencies` 白名单放行 electron/esbuild；Electron 二进制缺失时跑 `node node_modules/electron/install.js`。

## 许可

[AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html)：自由使用、修改、二次开发与分发（含商业渠道），**衍生作品必须以同协议开源**并保留署名。与 clawd-on-desk、LingChat 等同类桌宠项目一致。
