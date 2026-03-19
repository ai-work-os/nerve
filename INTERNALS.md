# Nerve 模块交互

代码级调用链，覆盖所有核心流程。

## 文件 → 职责

| 文件 | 职责 |
|------|------|
| `server.ts` | WS + HTTP 入口，解析 JSON-RPC，分发到 bus |
| `bus.ts` | 核心编排：频道管理、事件处理、广播 |
| `node-pool.ts` | 节点生命周期：spawn、stop、prompt |
| `acp-client.ts` | ACP 协议：握手、prompt、反向请求 |
| `adapter.ts` | CLI 命令模板：claude/codex/gemini/mock |
| `router.ts` | @mention 提取和路由 |
| `scheduler.ts` | process node 串行队列（一次只执行一个 prompt） |
| `store.ts` | SQLite 持久化（频道消息） |
| `transport.ts` | Stdio/WS 传输抽象 |
| `protocol.ts` | JSON-RPC 2.0 编解码 |

## 流程 1：Spawn Agent

```
:Nerve spawn claude alice
  → client.lua request("node.spawn", {adapter:"claude", name:"alice"})
  → server.ts handleRequest "node.spawn"
  → bus.spawnNode(adapter, name, cwd)
  → node-pool.ts _spawnProcess()
    → adapter.ts 获取 CLI 命令（如 claude --acp）
    → child_process.spawn() 启动子进程
    → 注入环境变量：NERVE_PORT, NERVE_NODE_NAME, PATH
    → StdioTransport 接管 stdin/stdout
    → AcpClient.handshake()
      → initialize → session/new
      → onReady(sessionId) → 状态设为 idle
  → 返回 {nodeId, name}
```

## 流程 2：1v1 聊天（channel.post @mention 方式）

```
:Nerve chat alice
  → chat.lua _do_open()
    → 创建 buffer + 输入框
    → _subscribe() 注册 node.update / statusChanged / channel.message 处理器
    → _setup_channel()
      → node.list 找到 alice 的 nodeId
      → channel.create {name:"dm:alice"}
      → channel.join（nvim 自己加入）
      → channel.addNode（alice 加入）

用户输入 "帮我看下这个文件"
  → chat.lua _submit()
  → client.request("channel.post", {channelId, content:"@alice 帮我看下这个文件"})
  → server.ts handleRequest "channel.post"
  → bus.ts postToChannel()
    → store.ts 持久化消息
    → 广播 channel.message 给频道所有 WS 节点
    → router.ts parseMentions() 提取 "@alice"
    → bus.ts 找到 alice 的 nodeId
    → node-pool.ts promptNode(nodeId, text)
      → scheduler 排队
      → acp-client.ts prompt(text)
        → session/prompt → agent 开始执行

agent 执行中持续推送:
  → agent stdout: session/update {type:"text", text:"..."}
  → acp-client.ts onUpdate(params)
  → node-pool.ts emit("node.update", node, params)
  → bus.ts handleNodeEvent("node.update")
    → 遍历 node 所在频道
    → 广播 {method:"node.update", params:{nodeId, name, ...detail}}
    → server.ts 发送给频道内所有 WS 客户端

nvim 收到 node.update:
  → client.lua _handle_message() → 分发到 notification_handlers
  → chat.lua _handlers.update(params)
    → _extract_text(params) 提取文本
    → _append_stream(text) 实时更新 buffer

agent 执行完毕:
  → prompt 返回 {stopReason:"end_turn"}
  → node-pool.ts 状态设为 idle
  → bus.ts 广播 node.statusChanged {status:"idle"}
  → chat.lua _update_winbar_status("idle") → _end_stream()
```

## 流程 3：频道多人协作

```
channel.post "@alice 改后端 @bob 改前端"
  → bus.ts postToChannel()
  → router.ts parseMentions() → ["alice", "bob"]
  → 对每个 mention:
    → bus.ts promptNode(nodeId, fullMessage)
    → 各自独立执行，各自推 node.update
    → 所有人通过 channel.message 看到频道消息
    → 通过 node.update 看到各 agent 的实时输出
```

## 流程 4：Agent 间通信

```
alice 执行中调用 nerve-post 脚本:
  → curl POST http://localhost:4800/post {from:"alice", content:"@bob 接口改好了"}
  → server.ts handleHttpRoute "/post"
  → bus.ts postToChannel()
    → 存消息、广播、路由 @bob
    → promptNode(bob, message)
```

## 广播机制

`bus.ts broadcastToChannel(channelId, notification)`:
- 遍历频道成员
- 对每个 WS 类型节点，通过其 WebSocket 连接发送 JSON
- process 节点（stdio）不通过广播收消息，只通过 prompt 收
