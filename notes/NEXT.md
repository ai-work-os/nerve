# 接下来要做什么

最后更新：2026-03-21

## 当前阶段：Phase 3 — 频道 + MCP 工具注入

Phase 1（1v1 聊天跑通）和 Phase 2（体验打磨）已完成。详见 ROADMAP.md。

完整研究记录见 `notes/acp-bus/20260320-155022/summary.md`。

## 产品愿景

```
手机 app ──┐
nvim 插件 ──┼── WS ──→ nerve server ──→ 多个 agent
CLI ────────┘
```

**nerve 是 server-first 的 agent orchestration runtime。** 多客户端连同一个 server。

## 里程碑路线（2026-03-21 确定）

| 里程碑 | 内容 | 验证环境 | 状态 |
|--------|------|----------|------|
| **M1: 频道 + MCP** | 频道可用 + MCP 工具注入 | nvim | **当前** |
| M2: 最小 CLI | `nerve chat/watch/send` 验证 WS API 完整性 | 终端 | 待做 |
| M3: 手机 app | 基于验证过的 WS API 做原生 app | iOS/Android | 待做 |

**TUI 不做。** acp-bus 的交互设计值得学，但直接应用到 nvim 插件和手机 app 里，不需要单独做 TUI 中间层。

### M1: 频道 + MCP（当前重点）

在 nvim 里验证频道协作的完整闭环。

**server 侧：**
1. **MCP 工具注入** — nerve_post 从 shell 命令升级为 MCP 工具
   - 新增 `src/nerve-mcp.ts`（stdio MCP server）
   - 改 `src/acp-client.ts`（session/new 传入 mcpServers）
   - 改 `src/node-pool.ts`（spawn 时构造 MCP 配置）
   - 补 `src/server.ts`（MCP server 需要的 endpoint）
2. **频道能力完善** — 修 MVP gap，补协作状态模型

**nvim 客户端侧：**
- 频道交互体验（加 agent、@mention、消息展示）
- 借鉴 acp-bus 的交互理念：
  - sidebar 协作态势面板（状态图标 + 等待关系 + 运行时间）
  - 消息 filter 切换（全局/单 agent）
  - conversation_id / waiting_reply_from 状态可视化

**验收标准：**
- 两个 agent 在频道里通过 MCP 工具互相通信，触发率显著高于 shell
- nvim 里能完成：创建频道 → 加 agent → 发任务 → 看协作 → @mention 路由

### M2: 最小 CLI

- `nerve chat [name]` — readline + WS 流式交互
- `nerve watch <channel>` — 流式看频道消息
- `nerve send <channel> <text>` — 发消息
- 管理命令：spawn/stop/list（已有部分）

**验收标准：** 不开 nvim，纯终端能完成频道协作完整闭环。

### M3: 手机 app

- 原生 app（不用 web，避免熄屏断连）
- 连 nerve server 的 WS API
- 交互参考 acp-bus 的设计理念 + M1 在 nvim 里验证过的模式

## 探索结论归档（2026-03-20 ~ 03-21）

详见 `notes/acp-bus/20260320-155022/summary.md`，包含 6 个研究主题：
1. ACP 协议能力摸底（nerve 用了 7/13 方法，session/update 是强类型联合）
2. 频道协作探索（主链路通，6 个 gap）
3. acp-bus 项目分析（MCP 工具注入、路由分段、协作状态模型）
4. Claude Code Channels（MCP 通知，不是多 agent，与 nerve 正交）
5. 架构定位（已解耦，补 CLI 入口即可，不需大改）
6. acp-bus TUI 交互设计（协作状态可视化 > 富文本渲染）

## 待做任务

### 近期（M1 相关）
- **MCP 工具注入**
- **频道 nvim 交互**
- ACP bug 修复（agentCapabilities 字段名、session/new 响应丢弃）

### 后续
- `/model` `/mode` 命令支持（~50 行）
- CLI 命令（M2）
- 手机 app（M3）

### 遇到再做
- 错误恢复：agent 挂了显示提示
- tool_call 结构化展示
- usage_update token/cost 追踪

## 已知问题

- agent 上下文满了后不响应但状态显示 idle，需要检测机制
- acp-bus-dispatch skill 缺少移除 agent 的命令
- `acp-client.ts` 读 `initResult.capabilities` 但规范字段是 `agentCapabilities`

## 工作方式

- 用户是协调者，你自主决定方案和实现
- 改完代码自己跑测试：`npx tsx test/self-test.ts`
- nvim 客户端代码在 `~/.config/nvim/lua/nerve/`
- nerve 服务端代码在本仓库 `src/`

## 关键上下文

- 1v1 不走频道，直连 node（node.prompt + node.subscribe）
- 内存 buffer 存实时输出，重连时 replay
- session/cancel 是 notification 不是 request
- Ctrl+C 取消绑在 chat.lua `_cancel()`
- _busy 标志只由 _submit/on_done 控制，不受 statusChanged 影响
