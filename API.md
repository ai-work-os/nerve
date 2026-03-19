# Nerve API 契约

版本：0.1.0

## 协议

- **主协议**：WebSocket JSON-RPC 2.0（`ws://localhost:{port}`）
- **辅助**：HTTP（仅 agent 进程用）

所有 WS 通信遵循 JSON-RPC 2.0：请求有 `id`，通知没有 `id`。

## 连接流程

```
客户端 → WS 连接 → node.register → 拿到 nodeId → 加入频道/操作节点
```

---

## 请求方法（客户端 → nerve）

### 节点管理

#### `node.register`
注册当前 WS 连接为一个节点。

```jsonc
// 请求
{ "method": "node.register", "params": { "name": "nvim", "capabilities": ["ui"], "permissions": "operator" } }
// 响应
{ "result": { "nodeId": "abc123", "name": "nvim" } }
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | 节点名，全局唯一 |
| capabilities | string[] | 否 | 默认 `["ui"]` |
| permissions | string | 否 | `"operator"` / `"member"` / `"observer"`，默认 `"operator"` |

#### `node.spawn`
启动一个 agent 进程。

```jsonc
// 请求
{ "method": "node.spawn", "params": { "adapter": "claude", "name": "alice", "cwd": "/path/to/project" } }
// 响应
{ "result": { "nodeId": "xyz789", "name": "alice" } }
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| adapter | string | 是 | `claude` / `c1` / `c2` / `codex` / `gemini` / `mock` |
| name | string | 否 | 自动生成如 `claude-1234` |
| cwd | string | 否 | 默认 `process.cwd()` |

#### `node.stop`
停止一个节点。

```jsonc
{ "method": "node.stop", "params": { "nodeId": "xyz789" } }
{ "result": { "ok": true } }
```

#### `node.list`
列出所有节点。

```jsonc
{ "method": "node.list", "params": {} }
{ "result": { "nodes": [NodeInfo] } }
```

#### `node.prompt`
直接向 agent 发送 prompt（1v1 直连，不经过频道）。

```jsonc
// 请求
{ "method": "node.prompt", "params": { "nodeId": "xyz789", "content": "帮我看下这个文件" } }
// 响应（prompt 执行完毕后返回）
{ "result": { "stopReason": "end_turn" } }
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| nodeId | string | 是 | 目标 agent 节点 |
| content | string | 是 | prompt 文本 |

执行期间，agent 的流式输出通过 `node.update` 通知推送给调用者。

---

### 频道管理

#### `channel.create`
创建频道。

```jsonc
{ "method": "channel.create", "params": { "name": "main", "cwd": "/path" } }
{ "result": { "channelId": "ch_abc", "name": "main", "cwd": "/path" } }
```

#### `channel.close`
关闭频道。

```jsonc
{ "method": "channel.close", "params": { "channelId": "ch_abc" } }
{ "result": { "ok": true } }
```

#### `channel.list`
列出所有频道。

```jsonc
{ "method": "channel.list", "params": {} }
{ "result": { "channels": [ChannelInfo] } }
```

#### `channel.join`
当前节点加入频道。

```jsonc
{ "method": "channel.join", "params": { "channelId": "ch_abc" } }
{ "result": { "ok": true } }
```

#### `channel.leave`
当前节点离开频道。

```jsonc
{ "method": "channel.leave", "params": { "channelId": "ch_abc" } }
{ "result": { "ok": true } }
```

#### `channel.addNode`
把指定节点加入频道。

```jsonc
{ "method": "channel.addNode", "params": { "channelId": "ch_abc", "nodeId": "xyz789", "name": "alice" } }
{ "result": { "ok": true } }
```

#### `channel.removeNode`
从频道移除节点。

```jsonc
{ "method": "channel.removeNode", "params": { "channelId": "ch_abc", "nodeName": "alice" } }
{ "result": { "ok": true } }
```

#### `channel.post`
向频道发消息。触发 @mention 路由。

```jsonc
{ "method": "channel.post", "params": { "channelId": "ch_abc", "content": "@alice 帮我改下后端" } }
{ "result": { "message": MessageInfo } }
```

#### `channel.history`
获取频道历史消息。

```jsonc
{ "method": "channel.history", "params": { "channelId": "ch_abc", "limit": 50, "before": 1710000000 } }
{ "result": { "messages": [MessageInfo] } }
```

---

### 会话管理

#### `session.list`
列出 agent 的所有历史会话。

```jsonc
{ "method": "session.list", "params": { "nodeName": "alice" } }
{ "result": { "sessions": [{ "sessionId": "sess_123", ... }] } }
```

#### `session.load`
恢复 agent 的历史会话。agent 会通过 `node.update` 推送历史内容。

```jsonc
{ "method": "session.load", "params": { "nodeName": "alice", "sessionId": "sess_123" } }
{ "result": { "ok": true } }
```

---

## 通知（nerve → 客户端）

通知没有 `id` 字段，客户端不需要响应。

### `channel.message`
频道中有新消息。广播给频道所有成员。

```jsonc
{ "method": "channel.message", "params": { "channelId": "ch_abc", "message": MessageInfo } }
```

### `channel.mention`
当前节点被 @mention。

```jsonc
{ "method": "channel.mention", "params": { "channelId": "ch_abc", "message": MessageInfo } }
```

### `channel.nodeJoined`
节点加入频道。

```jsonc
{ "method": "channel.nodeJoined", "params": { "channelId": "ch_abc", "nodeId": "xyz789", "nodeName": "alice" } }
```

### `channel.nodeLeft`
节点离开频道。

```jsonc
{ "method": "channel.nodeLeft", "params": { "channelId": "ch_abc", "nodeId": "xyz789", "nodeName": "alice" } }
```

### `node.update`
agent 的流式输出。nerve 透传 ACP `session/update` 的内容，不解析语义。

```jsonc
{ "method": "node.update", "params": { "nodeId": "xyz789", "name": "alice", ...detail } }
```

`detail` 的结构由 ACP agent 决定，nerve 不定义也不保证。客户端需要自行处理。

### `node.statusChanged`
节点状态变更。

```jsonc
{ "method": "node.statusChanged", "params": { "nodeId": "xyz789", "name": "alice", "status": "busy", "activity": "thinking" } }
```

status 取值：`connecting` | `idle` | `busy` | `error` | `stopped`

---

## HTTP 辅助接口

仅供 agent 进程使用（通过 curl/nerve-post 脚本调用）。

### `GET /health`
健康检查。

```jsonc
{ "status": "ok", "logFile": "/path/to/bus.log" }
```

### `POST /post`
agent 向所在频道发消息。

```jsonc
// 请求
{ "from": "alice", "content": "@main 任务完成" }
// 响应
{ "ok": true }
```

### `GET /log?tail=100`
读取最近日志。

---

## 数据类型

### NodeInfo

```typescript
{
  id: string
  name: string
  status: "connecting" | "idle" | "busy" | "error" | "stopped"
  capabilities: string[]
  permissions: "operator" | "member" | "observer"
  transport: "stdio" | "websocket"
  adapter?: string           // 仅 process node
  channels: string[]         // 所在频道 ID 列表
  createdAt: number          // unix timestamp
  lastActiveAt: number
}
```

### ChannelInfo

```typescript
{
  id: string
  name?: string
  cwd: string
  nodes: Record<string, string>  // nodeName → nodeId
  createdAt: number
}
```

### MessageInfo

```typescript
{
  id: string
  channelId: string
  from: string              // 发送者节点名
  content: string           // 消息文本
  timestamp: number         // unix timestamp
  metadata?: Record<string, unknown>
}
```

---

## 设计原则

1. **nerve 透传，不解析语义** — `node.update` 的 detail 是 ACP 协议的事，nerve 不管
2. **WS 为主，HTTP 为辅** — HTTP 只存在是因为 agent 进程没有持久 WS 连接
3. **频道是共享空间** — 消息持久化在 nerve 的 SQLite 里
4. **1v1 不经过频道** — `node.prompt` 直连，输出通过 `node.update` 推给调用者
5. **节点名全局唯一** — 用名字而非 ID 做 @mention 路由
