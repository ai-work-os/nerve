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
  },
  "duty-monitor": {
    type: "program",
    cmd: "npx",
    args: ["tsx", "src/plugins/duty-monitor/index.ts"],
    capabilities: ["monitor"],
    terminal: false,
    description: "系统健康巡检与定时任务",
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
