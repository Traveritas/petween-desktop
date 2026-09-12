# Petween Desktop

Petween 的独立 Windows 桌面版：把 [petween](https://github.com/Traveritas/petween)（DeepSeek Harness 桌宠动画中间件插件）以零改动装配级复用装进 Electron——透明置顶窗口里的桌宠 + 独立设置编辑器 + 本地 DSH 会话事件桥。

- 宠物联动本地 DSH（`dsh web`）的 agent 状态：思考 / 工作 / 等待审批 / 成功 / 出错；DSH 未运行时为纯装饰模式。
- 与 DSH 插件形态共享同一份 core（git submodule 单一上游），配置/宠物/动画/资产数据模型完全一致，支持从 `~/.dsh/petween` 一次性导入。

## 状态

🚧 实现尚未开始（2026-09-12 完成可行性评估与实施规划）。

- 可行性结论与风险：[docs/01-eval.md](docs/01-eval.md)
- 架构与装配指南：[docs/02-architecture.md](docs/02-architecture.md)
- DSH 状态桥规格：[docs/03-dsh-bridge-spec.md](docs/03-dsh-bridge-spec.md)
- Electron 技术要点：[docs/04-electron-notes.md](docs/04-electron-notes.md)
- **实施计划（当前进度）：[docs/05-mvp-plan.md](docs/05-mvp-plan.md)**

## 开发

```bash
git clone --recurse-submodules <this-repo>
cd vendor/petween && pnpm install && pnpm run build && pnpm vitest run
cd ../.. && pnpm install && pnpm dev
```

> ⚠️ 安装包未做代码签名：Windows 首次运行可能弹出 SmartScreen「Windows 已保护你的电脑」，选择「更多信息 → 仍要运行」。

## 许可

待定（跟随 petween 主仓库的授权决策）。
