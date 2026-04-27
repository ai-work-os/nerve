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
    args: ["tsx", "test/mock-agent.ts"],
    capabilities: ["code"],
    terminal: false,
    model: "mock-model-v1",
  },
  "mock-no-model": {
    cmd: "npx",
    args: ["tsx", "test/mock-agent.ts"],
    capabilities: ["code"],
    terminal: false,
  },
  "mock-session-close": {
    cmd: "npx",
    args: ["tsx", "test/mock-agent-session-close.ts"],
    capabilities: ["code"],
    terminal: false,
  },
  "mock-session-close-hang": {
    cmd: "npx",
    args: ["tsx", "test/mock-agent-session-close.ts"],
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
      subscribe: { description: "Subscribe to transcript pushes", args: { name: "subscriber name, or 'me' for self" } },
      unsubscribe: { description: "Unsubscribe from transcript pushes", args: { name: "subscriber name, or 'me' for self" } },
      subscribers: { description: "List current subscribers" },
      config: { description: "Set config (e.g. config interval 10)", args: { key: "interval", value: "seconds" } },
      flush: { description: "Immediately push buffered transcript to subscribers" },
    },
    usage: [
      "AI 的耳朵——实时音频感知能力。",
      "启动流程：",
      "1. nerve_spawn({ adapter: \"ai-ear\", name: \"ear-1\" })",
      "2. 创建或加入频道，把 ear-1 加入",
      "3. 让需要接收转录的节点订阅：nerve_command({ node: \"ear-1\", command: \"subscribe\", args: { name: \"接收者名\" } })",
      "   可以是自己，也可以是其他 agent（如专门的 analyst）",
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
    description: "定时闹钟——到点给指定 AI 发消息",
    commands: {
      add: { description: "添加定时任务", args: { schedule: "22:00 | Mon:08:00 | every:60m", message: "@target 消息" } },
      remove: { description: "删除任务", args: { name: "任务名" } },
      list: { description: "列出所有任务" },
      trigger: { description: "立即触发", args: { name: "任务名" } },
      status: { description: "运行状态" },
      check: { description: "立即健康检查" },
    },
    usage: [
      "定时闹钟——你告诉它几点给谁发什么，到点它就发。",
      "",
      "添加任务（DM 或频道 @duty-monitor）：",
      "  add 22:00 @duty-agent 写日报：总结今天各仓库 git 变化",
      "  add Mon:08:00 @duty-agent 整理本周 backlog",
      "  add every:60m @duty-agent 检查服务器健康",
      "",
      "管理任务：",
      "  list                    — 查看所有任务",
      "  remove 写日报            — 删除任务",
      "  trigger 写日报           — 立刻触发一次",
      "  status                  — 运行状态",
      "",
      "AI 也能用：AI 在频道里 @duty-monitor add 10:00 @自己 整理日志",
      "任务持久化到磁盘，重启不丢。",
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
    args: ["tsx", "test/mock-program.ts"],
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
