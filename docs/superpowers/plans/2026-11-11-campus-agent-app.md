# 独立 Agent 应用 · 实施计划

对应契约：[2026-11-11-campus-agent-app.md](../specs/2026-11-11-campus-agent-app.md)

## 分支与并行

| 分支 | worktree | 内容 | 依赖 |
| --- | --- | --- | --- |
| `feat/app-core` | 主检出 | `lib/app/**`、命令入口、core 测试、发布脚本、CI | 无 |
| `feat/app-webui` | `.local/worktrees/app-webui` | `webui/**` 静态 PWA | 契约 §5 |
| `feat/app-desktop` | `.local/worktrees/app-desktop` | `desktop/**` Windows 外壳 | 契约 §4 |
| `feat/app-mobile` | `.local/worktrees/app-mobile` | `mobile/**` Android + HarmonyOS | 契约 §6 |

三条客户端分支均从 `feat/app-core` 的首个提交（契约冻结）切出，合并顺序为 core → webui → desktop → mobile。

## core 分批

1. **基础**：`lib/app/settings.mjs`（配置与默认值）、`lib/app/tokens.mjs`（DPAPI 设备令牌库）、`lib/app/pairing.mjs`（配对码）。
2. **工具主机**：`lib/app/host.mjs`——复用 `lib/services.mjs` spawn 三个 stdio MCP 子进程，暴露 `list()` / `call()`，与 `lib/gateway.mjs` 共用恢复逻辑。
3. **模型路由**：`lib/app/model.mjs`——`madmodel` 与 `openai` 两条路由，统一 `models()` / `chat()`。
4. **Agent 循环**：`lib/app/agent.mjs`——tool-calling、SSE 事件、步数上限、取消。
5. **会话**：`lib/app/sessions.mjs`——JSON 落盘、摘要、删除。
6. **HTTP**：`lib/app/server.mjs`——路由、鉴权、Origin/Host 校验、静态资源、SSE。
7. **命令**：`bin/thu-campus.mjs app serve|invite|devices|status`。
8. **测试**：`test/app-*.test.mjs` 覆盖鉴权、配对、工具调用、SSE、取消、静态资源。

## 验收

- `npm run check` 全绿（含既有 40 项 bundle 测试）。
- `npm run app:smoke`：以 mock 服务启动运行时，跑通「配对 → 对话（含一次工具调用）→ 会话落库」。
- 合并四分支后 `npm run check` + `npm run smoke` 再跑一遍。

## 已知缺口（如实记录）

- Android：本机 Android SDK 无 `platforms/`、`build-tools/`，只能交付工程与构建说明，不出 APK。
- HarmonyOS：本机 DevEco 6.0 + SDK 齐全，尝试真实编译；无签名证书时只出未签名 HAP。
- 手机端必需同网段主机运行时（或后续托管部署），不承诺脱离主机独立运行。