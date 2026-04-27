# nerve

AI Work OS 的服务端核心。

`nerve` 不是聊天机器人，也不是普通的多 agent demo。它是一个把人、AI agent、程序节点接到同一个协作现场里的运行时：负责启动节点、管理连接、路由消息、记录频道、暴露工具，让多个 AI 可以围绕真实项目持续协作。

## 这个系统想做什么

目标是把“我和一个 AI 对话”升级成“我驾驭一组 AI 长期工作”。

当前阶段的核心判断：

- 人负责目标、关键判断、最终验收。
- AI 负责拆任务、写测试、实现、review、修复、汇报。
- 程序节点负责记录、定时、监听、转录、守护、触发。
- 频道是协作现场，DM 是一对一控制通道。
- 所有行动都要可观察、可回放、可验证。

终局不是多开几个模型，而是一个可治理的 AI 工作操作系统：未来能稳定调度成百上千甚至上万个 AI 节点，让它们按角色、任务、证据和验收闭环协作。

## 当前做到什么程度

已完成到 M6，正在推进 M6.5。

| 阶段 | 状态 | 结果 |
|---|---|---|
| M1 | 完成 | 独立 nerve server，可启动 agent、路由消息 |
| M2.5 | 完成 | TUI 1v1 DM 可日常使用 |
| M3 | 完成 | 频道协作、@mention 路由、多 agent 通信跑通 |
| M4 | 基本完成 | Android 可看 agent、DM、频道、spawn/stop |
| M5 | 基本完成 | 多频道、TUI 渲染、上下文管家、程序节点打磨完成 |
| M6 | 基本完成 | 程序节点 + 会议转录 + 多 agent 编排跑通 |
| M6.5 | 进行中 | AI 自主协作：从“人派活”走向“AI 自己发现、执行、汇报” |

已验证的能力：

- 启动/停止 AI agent 和程序节点。
- WebSocket JSON-RPC 连接 TUI、Android、程序节点。
- DM 直连 agent，频道内用 `@name` 路由任务。
- 频道消息 SQLite 持久化，长消息 blob 化。
- MCP 工具让 AI 能发频道消息、spawn 子 agent、加入频道。
- `context-guardian` 监控上下文，`user-recorder` 记录协作数据。
- `duty-monitor` 支持定时任务，把 AI 从被动等待变成主动值守。
- `ai-ear` / 会议转录链路已验证：会议内容进频道，AI 可基于转录讨论、分工、执行。
- harness 事件日志已开始建设，用结构化日志验证系统行为。

## 已验证的协作模式

### Mode B：自主管线

`tester -> coder -> reviewer`，main 只派任务和必要介入。

适合明确 bug 或小功能。已经验证 reviewer 能抓到实质问题，但多轮打回后仍需要人给更具体方向。

### Mode C：测试先审

tester 先写失败测试，reviewer 先审测试覆盖，再让 coder 实现。

核心是先确认“测得对不对”，再写代码。

### Mode D：sub-main 协调

main 只给目标，sub-main 负责排序、spawn worker、追踪进度、更新文件、卡住时请求确认。

已验证：

- 2026-04-01：5 个 server bug，434 tests passed，main 只介入 2 次。
- 2026-04-05：46 分钟跑 9 条线，产出 11 个 commits + 4 份探索文档。
- 合盖后 agent 仍能继续提交代码、更新进展文件。

这是当前最接近 AI 自主协作的模式。

## 下一步

M6.5 的收口目标：

- 一句话触发 Mode D，AI 自动完成测试、实现、review、commit、汇报。
- 复杂任务在关键方案点暂停，请求人确认后继续。
- 进展文件成为异步状态源，人回来直接看结果。
- 打回超过 2 轮自动升级。
- 多个 sub-main 可并行跑，互不干扰。
- harness 能把人工验收逐步程序化。

M7：服务器自治。

- 服务器上有值班 AI。
- 定时巡检、整理日志、处理 backlog、生成日报。
- 异常时主动通知手机。
- 用户不开电脑，也能早晚从手机看到 AI 做了什么。

M8：手机操控 + 跨机器同步。

- 手机能派活、看进度、做决策、stop agent。
- Mac、服务器、手机共享项目状态和个人信息。
- AI 在任何端都知道用户是谁、现在做什么、历史偏好是什么。

## 仓库关系

| 仓库 | 作用 |
|---|---|
| `nerve` | 服务端核心：节点、频道、消息、插件、harness |
| `nerve-tui` | 终端主力客户端 |
| `nerve-app` | 新 Android 客户端，当前重构版 |
| `nerve-android` | 旧 Android 客户端，保留历史和对照 |

## 常用命令

```bash
# 安装依赖
npm install

# 启动开发服务
npm run dev

# 指定测试端口启动
npx tsx src/cli.ts serve --port 4801

# 构建
npm run build

# 测试
npm run test:all
npm run test:legacy
```

也可以通过统一脚本管理：

```bash
nerve-server start
nerve-server status
nerve-server build nerve
nerve-server deploy nerve
```

## 开发约束

- 先在 worktree 的 `dev` 分支开发，验证后合回主仓库。
- 新功能和 bugfix 必须先写失败测试。
- 状态变化、命令执行、触发原因、异常必须有日志。
- `nerve` 管连接和路由，不存 DM 对话正文；agent 自己是 DM 历史的来源。
