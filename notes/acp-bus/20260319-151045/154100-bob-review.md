Review 结论：有 2 个明确回归，暂不建议合。

1. reopen 后 1v1 chat 实际失活
- 位置：[chat.lua](/Users/renjinxi/.config/nvim/lua/nerve/chat.lua#L39) 和 [chat.lua](/Users/renjinxi/.config/nvim/lua/nerve/chat.lua#L468)
- `hide()` 会 `_unsubscribe()` 并 `channel.close`。
- 但 `open()` 在已有 `buf` 时只执行 `_create_windows()` 就返回，不会重新 `_subscribe()` / `_setup_channel()`。
- 结果是第一次打开正常，`q` 关闭后再打开，同一个 buffer 不再接收 `node.update` / `channel.message`，发送也可能继续走旧状态。

2. 流式区域覆盖范围错误，会吞掉后续内容
- 位置：[chat.lua](/Users/renjinxi/.config/nvim/lua/nerve/chat.lua#L267)
- `_append_stream()` 每次都用 `nvim_buf_set_lines(self.buf, start, buf_lines, ...)`，直接替换从流起点到 buffer 末尾的所有行。
- 只要流式期间插入了别的内容，例如 `_append_system()` 的 tool 状态，后续 chunk 会把这些行覆盖掉。
- 相比之下，[acp/chat.lua](/Users/renjinxi/.config/nvim/lua/acp/chat.lua#L405) 只改最后一行再追加，不会整段抹掉尾部内容。

格式对齐补充：
- 主消息头部 `## You/Assistant` 基本对齐了。
- 但 tool 行文案仍未完全对齐：这里是 `tool: xxx`，ACP 是 `🔧 xxx`，属于样式差异，不是阻塞项。
