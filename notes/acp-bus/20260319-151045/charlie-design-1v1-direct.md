# 方案设计：1v1 直连（无频道）

## 核心思路

去掉 1v1 场景中的频道层，nvim 直接和 agent 通信。agent 按 cwd 分组，nvim 按 cwd 过滤。

## API 变更

### 1. node.spawn 返回值加 cwd

```diff
- { nodeId, name }
+ { nodeId, name, cwd }
```

### 2. NodeInfo 加 cwd 字段

BusNode 加 `cwd?: string` 属性，`toInfo()` 返回它。`node.list` 自然带上。

```typescript
// node.ts
cwd?: string;

toInfo(): NodeInfo {
  return { ...existing, cwd: this.cwd };
}
```

### 3. node.list 支持 cwd 过滤

```
node.list { cwd?: string }
```

传 cwd 时只返回该目录下 spawn 的 agent。不传返回全部。

### 4. 去掉 1v1 的频道依赖

当前 chat.lua 流程：spawn → create channel → join → addNode → prompt

简化为：spawn → prompt

**已有的 `node.prompt` + `node.update` 通知足够支撑 1v1**：
- `node.prompt { nodeId, content }` → 发消息
- `node.update` notification → 收流式回复
- `node.statusChanged` notification → 状态变化

频道只在多 agent 协作时才需要。

## nvim 端交互

### spawn

```
:Nerve spawn claude alice           -- cwd = vim.fn.getcwd()
:Nerve spawn claude alice /other    -- 指定 cwd
```

不变，已支持。

### chat

```
:Nerve chat alice                   -- 直接 chat，无需频道
:Nerve chat                         -- 无参数：列出当前 cwd 的 agent，选一个
```

**无参数流程**：
1. `node.list { cwd = vim.fn.getcwd() }` 获取当前项目的 agent
2. 只有一个 → 直接打开
3. 多个 → `vim.ui.select` 让用户选
4. 没有 → 提示 `先 :Nerve spawn`

### chat.lua 简化

```lua
function Chat:_do_open()
  -- 创建 buffer/window（不变）
  -- 查找 nodeId
  client.request("node.list", { cwd = vim.fn.getcwd() }, function(r)
    for _, n in ipairs(r.nodes) do
      if n.name == self.node_name then
        self.node_id = n.id
        break
      end
    end
    -- 订阅 node.update（已有）
    self:_subscribe()
    -- 不需要 _setup_channel
  end)
end
```

删除：`_setup_channel`、`channel.create`、`channel.join`、`channel.addNode`
保留：`_subscribe`（监听 node.update/statusChanged）、`_submit`（调 node.prompt）

## 多 nvim 连接

### 问题

两个 nvim 都注册 `name: "nvim"` 会冲突。

### 方案

nvim 注册时用 `nvim-{pid}`：

```lua
-- client.lua connect()
node_name = "nvim-" .. vim.fn.getpid()
```

多个 nvim 各自注册不同 name，各自订阅自己关心的 agent 的 `node.update`。

**node.update 广播范围需调整**：当前是广播给 agent 所在频道的所有成员。去掉频道后，改为广播给所有已连接的 WS 客户端（反正 chat.lua 里已经按 `params.name == self.node_name` 过滤了）。

### 实现

server.ts 的 `onEvent("node.update")` 改为：

```typescript
// 广播给所有 WS 客户端（不需要频道）
for (const [ws] of this.wsNodeMap) {
  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    method: "node.update",
    params: { nodeId: node.id, name: node.name, ...update },
  }));
}
```

客户端侧已有过滤，不会显示不关心的 agent 消息。

## 名字冲突

### agent 重名

保持严格拒绝。用户重启 nvim 后发现 agent 还在，直接 `:Nerve chat alice` 重连。

如果需要重启 agent：`:Nerve stop alice && :Nerve spawn claude alice`

### nvim 重名

`nvim-{pid}` 天然不冲突。

## 改动清单

| 文件 | 改动 |
|------|------|
| `src/node.ts` | 加 `cwd` 字段，`toInfo()` 返回 |
| `src/node-pool.ts` | spawn 时写入 `node.cwd` |
| `src/server.ts` | `node.list` 支持 cwd 过滤；`node.update` 广播给所有 WS 客户端 |
| `lua/nerve/client.lua` | 注册名改 `nvim-{pid}`；`spawn` 返回值处理 |
| `lua/nerve/chat.lua` | 删 `_setup_channel`；删频道相关逻辑；`_do_open` 简化 |
| `lua/nerve/init.lua` | `:Nerve chat` 无参数时按 cwd 过滤选择 |

## 不改的

- 频道机制保留，多 agent 协作时用
- updateBuffer / replay 保留，但 replay 触发点从 channel.join 改为客户端主动请求（`node.updates`）
- agent name 全局唯一策略不变
