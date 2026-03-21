# 频道最简实现方案

## 目标

让两个 agent 在频道里通过 MCP 工具互发消息，用户在 nvim 里看到协作过程。

## 当前可用 vs 需要改的

### 直接用（不动）
- `bus.ts` — channel CRUD、postMessage、broadcastToChannel、postFromProcess
- `router.ts` — @mention 解析和路由
- `channel.ts` — Channel 数据结构
- `server.ts` — `/post` HTTP 端点（MCP server 会调这个）
- `server.ts` — `channel.create/join/post/history` WS 方法
- nvim `view.lua` — 频道消息展示（基础可用）

### 需要简化
- `scheduler.ts` — **删掉调度队列，直接 prompt**。当前 scheduler 是串行队列（per-node max 10），用户要求不排队直接推送。

### 需要新建
- `src/nerve-mcp.ts` — MCP server（stdio），暴露 `nerve_post` + `nerve_list_agents` 工具

### 需要修改
- `src/acp-client.ts` — session/new 传 mcpServers（当前硬编码空数组）
- `src/node-pool.ts` — 构造 MCP 配置传给 AcpClient
- `src/bus.ts` — 去掉 scheduler，postMessage 里直接调 promptNode

## 分步实施

### Step 1：写 nerve-mcp.ts（MCP server）

**新建 `src/nerve-mcp.ts`**，约 80 行。

这是一个 stdio MCP server，被 claude-agent-acp 作为子进程 spawn。通过 HTTP 调 nerve server。

```typescript
// 用 @modelcontextprotocol/sdk
// 环境变量：NERVE_PORT, NERVE_NODE_NAME, NERVE_CHANNEL_ID

// 工具 1: nerve_post
// 参数: { to: string, content: string }
// 实现: POST http://localhost:${NERVE_PORT}/post
//       body: { from: NERVE_NODE_NAME, content: "@${to} ${content}" }

// 工具 2: nerve_list_agents
// 参数: 无
// 实现: POST http://localhost:${NERVE_PORT}/node/list
//       body: { cwd: process.cwd() }
//       返回: agent 名称和状态列表
```

**验收：** `echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | NERVE_PORT=4800 NERVE_NODE_NAME=test npx tsx src/nerve-mcp.ts` 能返回工具列表。

### Step 2：AcpClient 支持 mcpServers 注入

**改 `src/acp-client.ts`**：

1. `AcpClientOptions` 加 `mcpServers?: Array<{name, command, args, env}>` 字段
2. `handshake()` 的 `session/new` 调用，把 `mcpServers: []` 改为 `mcpServers: this.mcpServers ?? []`

```diff
// acp-client.ts handshake() 里的 session/new 调用
- mcpServers: [],
+ mcpServers: this.mcpServers ?? [],
```

顺手修 bug：
```diff
// acp-client.ts handshake() 里
- this.agentCapabilities = initResult.capabilities;
+ this.agentCapabilities = initResult.agentCapabilities ?? initResult.capabilities;
```

**验收：** handshake 日志里 session/new params 包含非空 mcpServers。

### Step 3：NodePool 构造 MCP 配置

**改 `src/node-pool.ts`**：

`_spawnProcess` 方法里，构造 mcpServers 配置传给 AcpClient：

```typescript
// 在创建 AcpClient 之前
const mcpServers = [{
  name: "nerve",
  command: process.execPath,  // node
  args: [path.join(__dirname, "nerve-mcp.js")],  // 编译后路径
  env: {
    NERVE_PORT: String(busPort),
    NERVE_NODE_NAME: name,
    // NERVE_CHANNEL_ID 暂时不传，agent 加入频道后再说
    // nerve-mcp.ts 里 postFromProcess 会自动找 node 的第一个频道
  }
}];

// 传给 AcpClient
const client = new AcpClient({
  transport,
  authMethod: adapter.authMethod,
  cwd,
  mcpServers,  // 新增
  onUpdate: ...,
  onReady: ...,
  onError: ...,
});
```

**验收：** spawn 的 agent 在工具列表里有 `nerve_post` 和 `nerve_list_agents`。

### Step 4：去掉 Scheduler，直接 prompt

**改 `src/bus.ts`**：

`postMessage` 里，把 scheduler.enqueue 改为直接 promptNode：

```diff
// bus.ts postMessage() 里的路由分发
for (const target of targets) {
  const node = this.nodePool.get(target.nodeId);
  if (node?.kind === "process") {
-   this.scheduler.enqueue(target.nodeId, channelId, msg);
+   // 直接 prompt，不排队，不等完成
+   this.nodePool.promptNode(target.nodeId, msg.content).catch(err => {
+     log.warn(`prompt ${target.nodeName} failed: ${err.message}`);
+   });
  }
}
```

同时更新系统提示（`buildSystemPrompt`），把 nerve-post shell 命令改为 MCP 工具说明：

```
你可以使用 nerve_post 工具给其他 agent 发消息。
格式：nerve_post({ to: "agent名", content: "消息内容" })
```

**验收：** 频道里 @mention 一个 agent，该 agent 直接收到 prompt（不排队）。

### Step 5：nvim 客户端调整

**改 `~/.config/nvim/lua/nerve/view.lua`**（最小改动）：

当前 view.lua 已有频道消息展示。需要确认：
1. `channel.message` 通知能正确显示 agent 间的消息（from 是 agent 名）
2. `node.update` 能在频道视图里显示 agent 的流式输出
3. `/add` 命令能 spawn + join 频道（当前 `/spawn` + `/join` 分开的，合并为一个）

如果 view.lua 已经能显示这些，**不改**。

**验收：** nvim 频道视图里能看到 agent A @mention agent B，B 收到后回复，A 再回复。

## 文件改动清单

| 文件 | 操作 | 改动量 |
|------|------|--------|
| `src/nerve-mcp.ts` | **新建** | ~80 行 |
| `src/acp-client.ts` | 改 | ~10 行（mcpServers 参数 + bug fix） |
| `src/node-pool.ts` | 改 | ~15 行（构造 MCP 配置） |
| `src/bus.ts` | 改 | ~20 行（去 scheduler + 改系统提示） |
| `package.json` | 改 | 加 `@modelcontextprotocol/sdk` 依赖 |
| **总计** | | **~125 行改动** |

## 不做的事

- ❌ Scheduler 排队（直接 prompt）
- ❌ 内容分段（全文广播，后续优化）
- ❌ reply_to 追踪（后续优化）
- ❌ agent 自治命令 /add /remove（后续优化）
- ❌ 活动超时（保持 300s，后续优化）
- ❌ tool_call 展示（后续优化）
- ❌ 命令补全（后续优化）
- ❌ nvim 大改（现有 view.lua 够用就不动）

## 测试流程

```bash
# 1. 启动 nerve
npx tsx src/cli.ts serve

# 2. nvim 里
:Nerve channel create test-chan
:Nerve channel add claude-1 claude
:Nerve channel add claude-2 claude

# 3. 在频道里发消息
@claude-1 分析一下当前目录的代码结构，然后 @claude-2 让它写测试

# 4. 观察
# - claude-1 收到 prompt，分析代码
# - claude-1 输出里 @claude-2（或用 nerve_post 工具）
# - claude-2 自动收到消息，开始写测试
# - 整个过程在 nvim 频道视图里可见
```

## 依赖

```bash
npm install @modelcontextprotocol/sdk
```
