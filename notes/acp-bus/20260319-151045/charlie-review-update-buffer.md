# Review: 内存 buffer 方案（node updateBuffer）

## 改动摘要

在 BusNode 上加 `updateBuffer: Record<string, unknown>[]`，用于客户端重连时重放 ACP session/update。

## 逐项 Review

### 1. Cap 逻辑（MAX_BUFFER_SIZE = 1000）

```ts
pushUpdate(params: Record<string, unknown>): void {
    this.updateBuffer.push(params);
    if (this.updateBuffer.length > BusNode.MAX_BUFFER_SIZE) {
        this.updateBuffer.shift();
    }
}
```

**问题：`shift()` 是 O(n) 操作**。每次超出 cap 都要移动 999 个元素。对于流式 chunk，高频调用会有性能问题。

建议改为 ring buffer 或用 `splice` 批量清理（比如超过 1200 时砍到 1000），避免每次 O(n)。

不过 1000 条的规模，实际影响不大，暂时可接受。

### 2. 内存泄漏风险

- `remove()` 时调用 `clearUpdateBuffer()` ✅
- `clearUpdateBuffer()` 直接 `this.updateBuffer = []` 释放旧数组 ✅
- **但 buffer 只在 remove 时清理**。长时间运行的 agent 如果不断被 prompt，buffer 会一直保持 1000 条。这不是泄漏（有 cap），但每个 node 最多占 ~1000 * avg_update_size 内存。

**潜在风险**：`promptNode` 里 `pushUpdate({ type: "prompt", text })` 把用户输入原文存进 buffer。如果用户发送大文本（贴代码等），单条就可能很大。建议对 prompt 类 update 的 text 截断，或不存原文。

### 3. 新 API 端点 `node.updates`

```ts
case "node.updates": {
    const nodeName = p.nodeName as string;
    if (!nodeName) { this.sendError(ws, id, -32602, "nodeName required"); return; }
    const updates = this.bus.getNodeUpdates(nodeName);
    this.sendResult(ws, id, { updates });
    break;
}
```

- 参数校验 ✅
- `getNodeUpdates` 返回浅拷贝 `[...node.updateBuffer]` ✅ 不会暴露内部引用
- **无权限检查**：任何 WS 客户端都能拉任意 node 的 update buffer。当前只有 nvim 一个客户端，暂时无影响，但后续多客户端时需注意。

### 4. channel.join 自动 replay

```ts
case "channel.join": {
    // ...
    this.replayChannelUpdates(ws, channelId);
    break;
}
```

`replayChannelUpdates` 遍历频道内所有 process node，把 buffer 全量发给新加入的 WS 客户端。

- 只 replay `isProcess` 节点 ✅（不会 replay WS 节点的消息）
- 用 `...update` 展开到 notification params ✅
- **时序问题**：replay 发生在 `sendResult` 之后。客户端收到 join 成功后立即收到一堆 update notification，逻辑上合理。

### 5. 与现有逻辑冲突

- `onUpdate` 里先 `pushUpdate` 再 `onEvent` — 顺序正确，buffer 先写，再广播给在线客户端
- `promptNode` 里 `pushUpdate` 在 `prompt()` 之前 — prompt 类 update 先于 agent 响应入 buffer，时序正确

**无冲突。**

## 结论

**LGTM，可合入。** 两个建议：
1. `shift()` 长期考虑换 ring buffer（当前规模可接受）
2. prompt 类 update 考虑截断 text（防大文本膨胀 buffer）
