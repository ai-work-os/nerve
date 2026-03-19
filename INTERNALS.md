# Nerve 内部实现

代码级调用链 + 文件结构。

## 文件结构

```
src/
  index.ts          入口
  cli.ts            CLI 命令（serve/status/channel/node/log/bridge）
  server.ts         WebSocket + HTTP server，JSON-RPC 分发
  bus.ts            核心编排：频道管理、事件处理、广播
  node.ts           BusNode 数据模型 + updateBuffer
  node-pool.ts      节点生命周期：spawn/stop/prompt + buffer 写入
  channel.ts        频道数据模型
  transport.ts      Stdio/WebSocket 传输抽象
  acp-client.ts     ACP 协议：握手、prompt、cancel、反向请求
  adapter.ts        CLI adapter 配置（claude/c1/c2/codex/gemini/mock）
  router.ts         @mention 路由
  scheduler.ts      process node 串行队列
  store.ts          SQLite 持久化（频道消息）
  protocol.ts       JSON-RPC 2.0 编解码
  logger.ts         文件 + stderr 日志
  nvim-bridge.ts    nvim ↔ bus 双向桥接
test/
  self-test.ts      端到端测试（118 个）
  mock-agent.ts     模拟 ACP agent
```

nvim 客户端（`~/.config/nvim/lua/nerve/`）：

```
init.lua      命令入口 :Nerve spawn|chat|status|stop|list
client.lua    WS JSON-RPC 客户端，节点注册/请求/通知
ws.lua        WebSocket 实现（RFC 6455, vim.uv TCP）
chat.lua      1v1 聊天视图，流式渲染，buffer replay
view.lua      频道面板 UI（Phase 4）
log.lua       文件日志
```

## 依赖关系

```
server.ts ──→ bus.ts ──→ node-pool.ts ──→ acp-client.ts ──→ protocol.ts
                │              │                                  │
                ├→ channel.ts  ├→ transport.ts ←─────────────────┘
                ├→ router.ts   └→ adapter.ts
                ├→ scheduler.ts
                └→ store.ts
```

## 流程 1：Spawn Agent

```
:Nerve spawn claude alice
  → client.lua request("node.spawn", {adapter:"claude", name:"alice", cwd:vim.fn.getcwd()})
  → server.ts handleRequest "node.spawn"
  → bus.spawnNode(adapter, name, cwd)
  → node-pool.ts _spawnProcess()
    → adapter.ts 获取 CLI 命令
    → child_process.spawn() 启动子进程
    → StdioTransport 接管 stdin/stdout
    → AcpClient.handshake(): initialize → session/new
    → onReady(sessionId) → 状态设为 idle
  → 返回 {nodeId, name}
```

## 流程 2：1v1 聊天（直连模式）

```
:Nerve chat
  → init.lua: 按 cwd 找 agent，没有则自动 spawn
  → chat.lua _do_open()
    → 创建 buffer + 输入框
    → client.request("node.subscribe", {nodeId})  订阅 update
    → 如果 agent 有 updateBuffer，server 自动 replay 历史

用户输入 "帮我看下这个文件"
  → chat.lua _submit()
    → 设置 _busy = true（拦截 Enter）
    → client.request("node.prompt", {nodeId, content:"帮我看下这个文件"})
  → server.ts handleRequest "node.prompt"
  → node-pool.ts promptNode(nodeId, text)
    → node.pushUpdate({user_message})  写入 buffer
    → scheduler 排队
    → acp-client.ts prompt(text) → agent 开始执行

agent 执行中持续推送:
  → agent stdout: session/update
  → acp-client.ts onUpdate(params)
  → node.pushUpdate(params)  写入 buffer
  → node-pool.ts emit("node.update", node, params)
  → server.ts 发送给所有 nodeSubscribers

nvim 收到 node.update:
  → chat.lua _handle_update(params)
    → _get_text(update.content) 提取文本
    → _append_stream(text) 实时更新 buffer

agent 执行完毕:
  → prompt 返回 {stopReason:"end_turn"}
  → _busy = false，解锁输入

用户按 Ctrl+C 取消:
  → chat.lua _cancel()
  → client.request("node.cancel", {nodeId})
  → acp-client.ts cancel() → 发 session/cancel notification（无 id）
```

## 流程 3：重连恢复（buffer replay）

```
nvim 关闭后重新打开:
  → :Nerve chat → 找到已有 agent
  → client.request("node.subscribe", {nodeId})
  → server.ts: 检测到 node 有 updateBuffer
  → 逐条以 node.update 推送给新订阅者
  → chat.lua 渲染历史（和实时输出格式一致）
```

## 流程 4：频道多人协作（Phase 4）

```
channel.post "@alice 改后端 @bob 改前端"
  → bus.ts postToChannel()
  → router.ts parseMentions() → ["alice", "bob"]
  → 对每个 mention: promptNode()
  → 各自推 node.update，频道内广播
```

## 广播机制

- **1v1**：通过 nodeSubscribers Map，只推给订阅了该 node 的 WS 客户端
- **频道**：通过 broadcastToChannel，推给频道内所有 WS 节点

## 数据文件

```
~/.nerve/
├── bus.db       SQLite（频道、消息、节点记录）
└── bus.log      server 运行日志
```
