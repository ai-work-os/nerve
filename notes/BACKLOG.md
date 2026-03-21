# Backlog（以后再说的细节）

M1 期间遇到的细节问题，记录但不做。

## 频道
- [ ] 频道恢复机制（server 重启后频道状态恢复）
- [ ] spawn ≠ join（spawn 只创建 agent，join 是显式加入频道）— 方案需修正
- [ ] reply_to 追踪
- [ ] conversation_id 对话链
- [ ] 内容分段（长消息拆分）
- [ ] agent 自治命令 /add /remove
- [ ] 活动超时优化
- [ ] 多频道切换 UI

## 体验
- [ ] tool_call 结构化展示
- [ ] 命令补全（Tab）
- [ ] usage/token 追踪
- [ ] mode/model 控制

## 架构
- [ ] scheduler 恢复（更稳的队列模型）
- [ ] nerve_read / nerve_members 工具
- [ ] 权限系统完善
- [ ] session/close 优雅关闭
