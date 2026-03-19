// Proxy env from system (needed for API access)
const proxyEnv = {};
for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"]) {
    if (process.env[k])
        proxyEnv[k] = process.env[k];
}
const adapters = {
    claude: {
        cmd: "claude-agent-acp",
        args: ["--yolo"],
        env: { ...proxyEnv },
        capabilities: ["code", "terminal", "analysis"],
        terminal: true,
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
    },
    gemini: {
        cmd: "gemini",
        args: ["--yolo", "--acp"],
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
    mock: {
        cmd: "npx",
        args: ["tsx", "test/mock-agent.ts"],
        capabilities: ["code"],
        terminal: false,
    },
};
export function getAdapter(name) {
    return adapters[name];
}
export function listAdapters() {
    return Object.keys(adapters);
}
//# sourceMappingURL=adapter.js.map