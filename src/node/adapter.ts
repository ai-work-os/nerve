export interface AdapterConfig {
  /** Node type: "acp" for AI agents (stdio+ACP), "program" for program nodes (WS reconnect) */
  type?: "acp" | "program";
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  authMethod?: string;
  capabilities: string[];
  terminal: boolean;
  /** Model preference written to settings.local.json for claude-agent-acp */
  model?: string;
  /** Program node connection timeout in ms (default 10000) */
  connectTimeout?: number;
  /** Human-readable description of the adapter */
  description?: string;
  /** Commands this adapter supports, with descriptions and optional args */
  commands?: Record<string, { description: string; args?: Record<string, string> }>;
  /** Usage guide for AI agents — typical workflows and best practices */
  usage?: string;
}

// Proxy env from system (needed for API access)
const proxyEnv: Record<string, string> = {};
for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"]) {
  if (process.env[k]) proxyEnv[k] = process.env[k]!;
}

const adapters: Record<string, AdapterConfig> = {
  claude: {
    cmd: "claude-agent-acp",
    args: ["--yolo"],
    env: { ...proxyEnv },
    capabilities: ["code", "terminal", "analysis"],
    terminal: true,
    model: "opus[1m]",
  },
  c1: {
    cmd: "claude-agent-acp",
    args: ["--yolo"],
    env: {
      ...proxyEnv,
      ...(process.env.CLAUDE_API1_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.CLAUDE_API1_BASE_URL } : {}),
      ...(process.env.CLAUDE_API1_TOKEN ? { ANTHROPIC_AUTH_TOKEN: process.env.CLAUDE_API1_TOKEN } : {}),
    },
    capabilities: ["code", "terminal", "analysis"],
    terminal: true,
    model: "opus[1m]",
  },
  c2: {
    cmd: "claude-agent-acp",
    args: ["--yolo"],
    env: {
      ...proxyEnv,
      ...(process.env.CLAUDE_API2_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.CLAUDE_API2_BASE_URL } : {}),
      ...(process.env.CLAUDE_API2_TOKEN ? { ANTHROPIC_AUTH_TOKEN: process.env.CLAUDE_API2_TOKEN } : {}),
    },
    capabilities: ["code", "terminal", "analysis"],
    terminal: true,
    model: "opus[1m]",
  },
  gemini: {
    cmd: "gemini",
    args: ["--acp"],
    authMethod: "oauth-personal",
    capabilities: ["code", "analysis"],
    terminal: false,
  },
  codex: {
    cmd: "codex-acp",
    args: ["-c", 'sandbox_permissions=["disk-full-read-access"]'],
    capabilities: ["code"],
    terminal: false,
  },
  opencode: {
    cmd: "opencode",
    args: ["acp"],
    capabilities: ["code", "analysis"],
    terminal: false,
  },
  kimi: {
    cmd: "kimi-cli",
    args: ["acp"],
    capabilities: ["code", "analysis"],
    terminal: false,
  },
  mock: {
    cmd: "npx",
    args: ["tsx", "test/legacy/mock-agent.ts"],
    capabilities: ["code"],
    terminal: false,
    model: "mock-model-v1",
  },
  "mock-no-model": {
    cmd: "npx",
    args: ["tsx", "test/legacy/mock-agent.ts"],
    capabilities: ["code"],
    terminal: false,
  },
  "mock-session-close": {
    cmd: "npx",
    args: ["tsx", "test/legacy/mock-agent-session-close.ts"],
    capabilities: ["code"],
    terminal: false,
  },
  "mock-session-close-hang": {
    cmd: "npx",
    args: ["tsx", "test/legacy/mock-agent-session-close.ts"],
    env: { HANG_ON_CLOSE: "1" },
    capabilities: ["code"],
    terminal: false,
  },
  guardian: {
    type: "program",
    cmd: "npx",
    args: ["tsx", "src/plugins/context-guardian/index.ts"],
    capabilities: ["monitor"],
    terminal: false,
    description: "AI 上下文容量监控与自动重置",
  },
  "ai-ear": {
    type: "program",
    cmd: "npx",
    args: ["tsx", "src/plugins/ai-ear/index.ts"],
    env: {
      DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY || "",
    },
    capabilities: ["monitor"],
    terminal: false,
    description: "实时音频采集与转录",
    commands: {
      start: { description: "Start recording", args: { source: "mic / system / both" } },
      stop: { description: "Stop recording" },
      continue: { description: "Resume recording" },
      status: { description: "Show current status" },
      config: { description: "Set config (e.g. config interval 10)", args: { key: "interval", value: "seconds" } },
      flush: { description: "Immediately push buffered transcript to subscribers" },
    },
    usage: [
      "AI 的耳朵——实时音频感知能力。",
      "启动流程：",
      "1. nerve_spawn({ adapter: \"ai-ear\", name: \"ear-1\" })",
      "2. 创建或加入频道，把 ear-1 加入",
      "3. 订阅转录事件：nerve_command({ node: \"ear-1\", command: \"subscribe\", args: { event: \"transcription\" } })",
      "   subscribe/unsubscribe/subscribers 是所有程序节点的内置命令，按事件类型订阅。",
      "4. nerve_command({ node: \"ear-1\", command: \"start\", args: { source: \"mic\" } })",
      "转录内容定期推送到频道（默认5分钟/300秒），@mention 所有订阅者。",
      "可用 config 调整推送频率：nerve_command({ node: \"ear-1\", command: \"config\", args: { key: \"interval\", value: \"30\" } })  // 单位：秒",
    ].join("\n"),
  },
  "duty-monitor": {
    type: "program",
    cmd: "npx",
    args: ["tsx", "src/plugins/duty-monitor/index.ts"],
    capabilities: ["monitor"],
    terminal: false,
    description: "定时闹钟——到点通知订阅者执行任务",
    commands: {
      add: { description: "添加定时任务", args: { schedule: "HH:MM | Day:HH:MM | every:Nm", message: "任务内容" } },
      remove: { description: "删除任务", args: { name: "任务名" } },
      list: { description: "列出所有任务" },
      trigger: { description: "立即触发", args: { name: "任务名" } },
      status: { description: "运行状态" },
      check: { description: "立即健康检查" },
    },
    usage: [
      "定时闹钟——到点通知订阅者执行任务。",
      "",
      "1. 添加任务：",
      "  nerve_command({ node: \"duty-monitor\", command: \"add\", args: { schedule: \"22:00\", message: \"写日报\" } })",
      "",
      "2. 订阅任务（不同 AI 订阅不同任务）：",
      "  nerve_command({ node: \"duty-monitor\", command: \"subscribe\", args: { event: \"task_fired\", filter: \"写日报\" } })",
      "  nerve_command({ node: \"duty-monitor\", command: \"subscribe\", args: { event: \"health_alert\" } })",
      "  subscribe 不带 filter 则收该类型所有事件。",
      "",
      "3. 管理任务：",
      "  list / remove <名> / trigger <名> / status",
      "",
      "任务持久化到磁盘，重启不丢。",
    ].join("\n"),
  },
  "ai-life-log": {
    type: "program",
    cmd: "npx",
    args: ["tsx", "src/plugins/ai-life-log/index.ts"],
    capabilities: ["monitor"],
    terminal: false,
    description: "24/7 本地麦克风转录，按天滚动追加到日志文件",
    commands: {
      pause: { description: "暂停录音（保留进程）" },
      resume: { description: "恢复录音" },
      status: { description: "查看状态：运行中/暂停/错误，今日累计行数与字符数" },
    },
    usage: [
      "AI 的生活日志——被动 24/7 录麦本地转录，按天滚动追加到",
      "~/.nerve/plugins/ai-life-log/log/YYYY-MM-DD.txt。",
      "",
      "随 nerve 自启 (cli.ts startLifeLog)，无需 nerve_spawn。",
      "仅 macOS。模型：sherpa-onnx + sensevoice-small (本地)。",
      "模型缺失时节点不崩，进入 idle error 状态。",
      "",
      "命令：",
      "  pause / resume — 隐私场合手动控制",
      "  status — 当前状态 + 今日累计行数字数",
    ].join("\n"),
  },
  "observer": {
    type: "program",
    cmd: "npx",
    args: ["tsx", "src/plugins/observer/index.ts"],
    capabilities: ["monitor"],
    terminal: false,
    description: "节点行为观察与记录",
  },
  "feishu-bridge": {
    type: "program",
    cmd: "npx",
    args: ["tsx", "src/plugins/feishu-bridge/index.ts"],
    capabilities: ["bridge"],
    terminal: false,
    description: "飞书机器人 ↔ nerve 频道桥（长连接 + AI 自动回复）",
    usage: [
      "把飞书机器人收到的消息桥接进 nerve。每个飞书会话独立一个 nerve 频道，",
      "首次消息时自动 spawn AI agent（默认 codex）进频道；AI 在频道的回复",
      "自动 reply 回飞书。",
      "",
      "前置：~/.nerve/feishu.json 含 { app_id, app_secret }，机器人开启长连接",
      "事件订阅 + im.message.receive_v1 权限。",
      "",
      "通常随 nerve 自启（cli.ts startFeishuBridge），无需手动 spawn。",
    ].join("\n"),
  },
  "user-recorder": {
    type: "program",
    cmd: "npx",
    args: ["tsx", "src/plugins/user-recorder/index.ts"],
    capabilities: ["monitor"],
    terminal: false,
    description: "用户对话记录",
  },
  "mock-program": {
    type: "program",
    cmd: "npx",
    args: ["tsx", "test/legacy/mock-program.ts"],
    capabilities: ["monitor"],
    terminal: false,
  },
  "mock-program-timeout": {
    type: "program",
    cmd: "sleep",
    args: ["60"],
    capabilities: ["monitor"],
    terminal: false,
    connectTimeout: 3000,
  },
  "mock-program-crash": {
    type: "program",
    cmd: "node",
    args: ["-e", "process.exit(42)"],
    capabilities: ["monitor"],
    terminal: false,
  },
  "mock-program-badcmd": {
    type: "program",
    cmd: "nonexistent-command-that-does-not-exist",
    args: [],
    capabilities: ["monitor"],
    terminal: false,
    connectTimeout: 3000,
  },
};
adapters["context-guardian"] = adapters["guardian"]; // alias: node name → adapter

export function getAdapter(name: string): AdapterConfig | undefined {
  return adapters[name];
}

export function listAdapters(): string[] {
  return Object.keys(adapters);
}

export function listProgramAdapters(): Record<string, AdapterConfig> {
  const result: Record<string, AdapterConfig> = {};
  for (const [name, config] of Object.entries(adapters)) {
    if (config.type === "program" && !name.startsWith("mock-")) {
      result[name] = config;
    }
  }
  return result;
}
