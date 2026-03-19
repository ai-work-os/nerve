# Review: 1v1 agent 管理改造

## 1. 通信链路完整性

`node.subscribe` → `bus.onNodeEvent` hook → `notifyNodeSubscribers` → WS push

链路完整：
- prompt → node-pool `onUpdate` → bus `handleNodeEvent` → `onNodeEvent` hook → server push to subscribers ✅
- statusChanged → 同路径 ✅
- subscribe 时自动 replay updateBuffer ✅
- `notifyNodeSubscribers` 检查 `ws.readyState === WebSocket.OPEN` ✅

**无问题。**

## 2. 自动命名边界情况

```typescript
private generateNodeName(adapter: string, cwd: string): string {
    const base = `${adapter}-${basename(cwd)}`;
```

- cwd = `/tmp` → `mock-tmp` ✅
- cwd = `/` → `basename("/")` = `""` → name = `mock-` ⚠️ 有效但不好看
- cwd = `/home/user/my project` → `mock-my project`（含空格）⚠️ 功能不影响但显示奇怪

**建议**：对 basename 结果做 fallback（空时用 `root`），或 sanitize 空格/特殊字符。不阻塞合入。

## 3. 内存泄漏检查

### WS 断连时清理
```typescript
// line 62-65: ws close handler
for (const [, subs] of this.nodeSubscribers) {
    subs.delete(ws);
}
```
遍历所有 node 的订阅者集合，移除断连的 ws。✅

### node 被 stop/remove 时
**问题**：node 被 remove 后，`nodeSubscribers.get(nodeId)` 的 Set 仍留在 Map 里。虽然不会再有事件推送（node 已不存在），但空 Set 永远不会被清理。

**影响**：轻微。长时间运行 + 频繁 spawn/stop 会积累空 Set。每个空 Set 占 ~几十字节。

**建议**：在 `node.remove` 或 `bus.onNodeEvent("node.stopped")` 时 `nodeSubscribers.delete(nodeId)`。

### node.unsubscribe
```typescript
const subs = this.nodeSubscribers.get(targetId);
if (subs) subs.delete(ws);
```
正确移除单个订阅。但同样不清理空 Set。✅（同上建议）

## 4. 测试覆盖

| 测试 | 覆盖 |
|------|------|
| subscribe → 收 update | ✅ testNodeSubscribe |
| subscribe → 收 statusChanged | ✅ testNodeSubscribe |
| unsubscribe → 不再收 | ✅ testNodeSubscribe |
| cwd 过滤（WS + HTTP） | ✅ testNodeListCwdFilter |
| NodeInfo 含 cwd | ✅ testNodeListCwdFilter |
| 自动命名 | ✅ testAutoNaming |
| 自动命名序号 | ✅ testAutoNaming（-2 后缀）|
| 多 nvim 共享 agent | ✅ testMultiNvim |
| 完整 1v1 流程 | ✅ testOneStepChat |
| WS 断连清理 | ❌ 没测 |
| node stop 后 subscriber 清理 | ❌ 没测 |
| basename 边界（/、空格） | ❌ 没测 |

覆盖充分，核心路径都有。缺的是边界和清理场景。

## 结论

**LGTM，可合入。** 两个小建议：
1. `generateNodeName`：basename 为空时 fallback 到 `"root"` 或类似默认值
2. node remove 时 `nodeSubscribers.delete(nodeId)` 清理空 Set
