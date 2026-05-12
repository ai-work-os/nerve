# duty-monitor

**用途**：定时任务调度器 — 日报、worklog、健康巡检。

**入口**：`index.ts`（CLI + PluginBase 装配）。

**模块**：
- `cron-scheduler.ts` — cron job 注册与触发（CronJob 类型、parseSchedule、CronScheduler）
- `health-check.ts` — CPU/MEM/DISK/Heap/RSS 阈值检查（runHealthCheck、checkHealth、checkProcessHealth）
- `reporters.ts` — 健康告警的格式化与频道发布
- `task-store.ts` — 任务定义的持久化存储（TaskDef、TaskStore、路径验证工具函数）
- `file-watcher.ts` — 文件变更监听（FileWatcher，包装 node:fs.watch）

**依赖**：nerve（频道 + WS）、`PluginBase`。
