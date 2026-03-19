# ACP 协议参考

Agent Communication Protocol — nerve 与 agent 进程之间的 stdio JSON-RPC 协议。

## 握手流程

```
nerve                          agent (claude-agent-acp)
  ├── initialize ──────────────►
  │   {protocolVersion: 1,      │
  │    clientInfo: {name:"nerve"}}
  ◄── result ──────────────────┤
  │   {agentInfo: {name:"claude"}}
  │                             │
  ├── session/new ─────────────►
  │   {cwd: "/path", mcpServers:[]}
  ◄── result ──────────────────┤
  │   {sessionId: "sess_xxx"}   │
  │                             │
  │   (握手完成，agent 就绪)     │
```

## 核心方法

### session/prompt（nerve → agent）

```jsonc
{
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_xxx",
    "prompt": [{ "type": "text", "text": "帮我看下这个文件" }]
  }
}
// 响应（agent 执行完毕后返回）
{ "result": { "stopReason": "end_turn" } }
```

stopReason 取值：`end_turn` | `max_tokens` | `tool_use` | `stop_sequence`

### session/update（agent → nerve，通知）

agent 执行期间持续推送，**没有 id 字段**（是通知不是请求）。

```jsonc
{
  "method": "session/update",
  "params": { ...detail }
}
```

**detail 结构不固定**，取决于 agent 实现。常见格式：

```jsonc
// 文本输出
{ "type": "text", "text": "分析结果..." }

// 增量文本（流式）
{ "type": "content_block_delta", "delta": { "text": "一段文本" } }

// 工具调用
{ "type": "tool_use", "name": "Read", "input": { "path": "/foo" } }

// 工具结果
{ "type": "tool_result", "output": "文件内容..." }

// 思考过程
{ "type": "thinking", "text": "让我想想..." }
```

**nerve 透传这些内容，不解析语义。** 客户端需要自行处理。

### session/list（nerve → agent）

```jsonc
{ "method": "session/list", "params": {} }
// 响应
{ "result": { "sessions": [{ "sessionId": "sess_xxx", ... }] } }
```

### session/load（nerve → agent）

恢复历史会话。agent 会通过 session/update 推送历史内容。

```jsonc
{ "method": "session/load", "params": { "sessionId": "sess_xxx" } }
```

## 反向请求（agent → nerve）

agent 执行中可以请求 nerve 提供能力：

| 方法 | 说明 |
|------|------|
| `fs/read_text_file` | 读文件 `{path, line?, limit?}` → `{content}` |
| `fs/write_text_file` | 写文件 `{path, content}` → `{}` |
| `terminal/create` | 创建终端 `{command?, args?}` → `{terminalId}` |
| `terminal/output` | 读终端输出 `{terminalId}` → `{output}` |
| `terminal/wait_for_exit` | 等待退出 `{terminalId}` → `{exitCode}` |
| `terminal/kill` | 杀终端 `{terminalId}` |
| `terminal/release` | 释放终端 `{terminalId}` |
| `session/request_permission` | 请求权限 → nerve 自动批准 `{allowed: true}` |

## node.update 透传链路

```
agent 推 session/update {type:"text", text:"..."}
  → acp-client.ts onUpdate(params)
  → node-pool.ts emit("node.update", node, params)
  → bus.ts handleNodeEvent
  → 构造 WS 通知: {method:"node.update", params:{nodeId, name, ...detail}}
  → 广播给 node 所在频道的所有 WS 客户端
```

客户端收到的 `node.update` params 是 `{nodeId, name}` + detail 字段展开。
