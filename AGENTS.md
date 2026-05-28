# nerve AI 入口

`nerve` 是 Nova / ai-work-os 的后台服务核心。它负责进程管理、消息路由、频道、程序节点、WebSocket/HTTP/MCP 接口，以及一批长期运行的后台插件。它不负责替 AI 解释对话语义。

## 当前角色

| 主题 | 当前事实 |
| --- | --- |
| 服务定位 | 后台核心服务，连接人、AI 节点、程序节点和客户端 |
| 运行形态 | home 生产环境使用 user-level `systemd` 的 `nerve.service` |
| 客户端 | Android 是主要协作/控制面之一；TUI 多用于终端观察和调试 |
| 运行数据 | 主要在 `~/.nerve/`，不要把运行流水写回 `~/.ai/` |

## 常用命令

```bash
npm test
npm run build
npm run test:unit
npm run test:integration
npx vitest run path/to/test.ts
```

本地开发可用 `npm run dev` 启动服务。生产服务不要默认用 Mac-only wrapper 操作；home 上优先按 user-level `systemd` 的边界理解和验证。

## 关键目录

| 路径 | 说明 |
| --- | --- |
| `src/cli.ts` | CLI 入口 |
| `src/transport/` | HTTP / WebSocket API 和协议边界 |
| `src/node/` | 节点池、agent / program node 生命周期 |
| `src/channel/` | 频道成员、消息路由和频道事件 |
| `src/service/` | service supervisor、重启检测等后台服务支撑 |
| `src/mcp/` / `src/channel-mcp/` | MCP 工具与频道接入 |
| `src/plugins/` | 后台插件和 program node 能力 |
| `src/plugins/plugin-base.ts` | 新插件优先参考的基类和生命周期边界 |
| `scenes/` | 场景、自启和服务监督相关配置 |
| `test/` | vitest 测试 |

## 插件和程序节点边界

| 插件/能力 | 边界 |
| --- | --- |
| `context-guardian` | 上下文守护，不要混进业务消息路由 |
| `duty-monitor` | 值守任务、健康检查、通知 |
| `ai-life-log` | life log 服务端处理和 HTTP 接收 |
| `feishu-bridge` | 飞书桥接和文本提取 |
| `system-watchdog` | 系统静默、异常和报告 |
| `screenshot` | 截图接收、存储、HTTP 服务 |
| program node | 被 nerve 管理的外部能力节点，生命周期要和普通 AI agent 区分 |

新增插件时先看 `src/plugins/plugin-base.ts`，明确启动、停止、状态、日志和错误传播。后台服务、自启、scene、service supervisor 是不同边界，不要把临时开发脚本写成生产守护逻辑。

## 修改规则

- 只描述和修改当前仓库事实；跨仓需求先确认涉及面。
- 不要把 `~/.ai/` 当作 nerve runtime 目录。
- 不要默认写 `dev` 分支；当前默认按 `main` 理解。
- 不要把历史客户端和早期阶段叙述当作当前事实。
- 改消息路由、节点生命周期、插件启动或持久化路径时，必须有 focused test。
- 改生产服务或自启相关内容时，说明本地验证和 home/systemd 验证分别覆盖了什么。

## 旧入口

`ai/ai.md` 只保留跳转说明。本仓主入口是这个 `AGENTS.md`；`CLAUDE.md` 应指向 `AGENTS.md`。
