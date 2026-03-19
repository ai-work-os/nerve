# Nerve — 项目状态

最后更新：2026-03-18

## 协作模式

你是这个项目的主人。自主决定架构、方案、优先级。改完代码自己跑测试验证。

- 自验证：`npx tsx test/self-test.ts`
- 日志：`~/.nerve/bus.log` 或 `npx tsx src/cli.ts log`
- 需要决断时找 main，main 定不了的升级给用户

## 已完成功能

| 功能 | 状态 | 文件 |
|------|------|------|
| WebSocket API（12 端点） | ✅ | server.ts |
| HTTP API（10 端点） | ✅ | server.ts |
| ACP 握手（initialize → session/new → prompt） | ✅ | acp-client.ts |
| SQLite 持久化 | ✅ | store.ts |
| @mention 路由 | ✅ | router.ts |
| Scheduler 串行调度 | ✅ | scheduler.ts |
| CLI 工具（serve/status/channel/node/log/bridge） | ✅ | cli.ts |
| 真实 Claude agent spawn | ✅ | adapter.ts, node-pool.ts |
| nvim bridge | ✅ | nvim-bridge.ts |
| 日志系统（文件 + CLI + HTTP） | ✅ | logger.ts |
| Mock agent | ✅ | test/mock-agent.ts |
| 自验证体系（46 + 5 测试） | ✅ | test/self-test.ts, test/bridge-test.ts |

## 关键修复记录

- **CLAUDECODE=1**：从 CC 内部 spawn claude-agent-acp 时子进程继承此变量导致 session/new 失败。修复：spawn 前清除 CLAUDECODE 相关环境变量
- **protocolVersion**：从 "0.1.0" 改为数字 1，对齐 nvim 实现

## 启动方式

```bash
npm install
npx tsx src/cli.ts serve          # 启动 server（端口 4800）
npx tsx src/cli.ts status         # 查看状态
npx tsx src/cli.ts node spawn claude --name alice   # 启动真实 claude agent
npx tsx src/cli.ts bridge --sock $NVIM_LISTEN_ADDRESS  # 连接 nvim
npx tsx src/cli.ts log            # 查看日志
npx tsx test/self-test.ts         # 跑全部测试
```

## 待做

1. **Codex adapter 验证** — claude 已通，codex 还没测试真实 spawn
2. **用户实际验收** — 用户还没亲自跑过
3. **nvim 端体验** — bridge 基本功能有了，实际体验待验证

## 文件结构

```
src/
  index.ts          入口
  cli.ts            CLI 命令（serve/status/channel/node/log/bridge）
  server.ts         WebSocket + HTTP server
  bus.ts            核心编排（频道/节点/事件）
  node.ts           Node 数据模型
  node-pool.ts      节点生命周期管理
  channel.ts        频道数据模型
  transport.ts      Stdio/WebSocket 传输抽象
  acp-client.ts     ACP 协议客户端（握手 + prompt + 反向请求）
  adapter.ts        CLI adapter 配置（claude/c1/c2/codex/gemini/mock）
  router.ts         @mention 路由
  scheduler.ts      Process Node 串行调度
  store.ts          SQLite 持久化
  protocol.ts       JSON-RPC 2.0 编解码
  logger.ts         日志模块（文件 + 终端）
  nvim-bridge.ts    nvim ↔ Bus 双向桥接
test/
  self-test.ts      端到端自测（46 测试）
  bridge-test.ts    nvim bridge 测试（5 测试）
  mock-agent.ts     模拟 ACP agent
```

## 设计文档

- 完整架构：`~/.ai/ai-work-os/DESIGN-bus-server.md`
- 核心决策：`~/.ai/ai-work-os/CORE-DECISIONS.md`
- Codex 评审：`~/.ai/ai-work-os/REVIEW-codex-feedback.md`
