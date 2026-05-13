#!/usr/bin/env node
/**
 * feishu-bridge — nerve plugin node that bridges a Feishu bot to nerve channels.
 *
 * Inbound: feishu im.message.receive_v1 → channel.post into a per-chat nerve channel.
 *          AI agent (codex/gemini/claude) is spawned lazily and joined to the channel.
 * Outbound: agent's `nerve_post({to: "feishu-bridge", ...})` → node.message → feishu reply.
 *
 * DM commands (TUI DM the bridge node):
 *   status                 — feishu status + mapping count + current default adapter
 *   list                   — list all feishu chat ↔ channel mappings
 *   agent <codex|gemini>   — set default adapter for new chats (existing chats unchanged)
 *   clear                  — drop ALL mappings (existing codex/gemini processes survive)
 *   clear <feishuChatId>   — drop a single mapping
 *
 * Credentials file ~/.nerve/feishu.json:
 *   { "app_id": "cli_xxx", "app_secret": "..." }
 */

import { resolve } from "node:path";

import { PluginBase, type CommandDef, type CommandResult } from "../plugin-base.js";
import { BridgeCore, type NerveTransport } from "./bridge-core.js";
import { MappingStore } from "./mapping.js";
import { loadConfig, defaultConfigPath } from "./config.js";
import { FeishuClient, type IFeishuClient } from "./feishu-client.js";

function getArg(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

const PORT = parseInt(process.env.NERVE_PORT || getArg("--port", "4800"));
const CONFIG_PATH = getArg("--config", defaultConfigPath());
const AGENT_ADAPTER = getArg("--agent", "codex");

export interface FeishuBridgeOptions {
  port: number;
  mappingPath?: string;
  configPath?: string;
  client?: IFeishuClient;
  agentAdapter?: string;
}

export class FeishuBridge extends PluginBase {
  private core?: BridgeCore;
  private client: IFeishuClient;
  private mappingPath: string;
  private agentAdapter: string;

  constructor(opts: FeishuBridgeOptions) {
    super({
      port: opts.port,
      name: "feishu-bridge",
      capabilities: ["bridge"],
      permissions: "operator",
    });
    this.mappingPath = opts.mappingPath || resolve(this.dataDir, "mapping.json");
    this.agentAdapter = opts.agentAdapter || "codex";

    if (opts.client) {
      this.client = opts.client;
    } else {
      const cfg = loadConfig(opts.configPath || defaultConfigPath());
      this.client = new FeishuClient(cfg, (lvl, msg) => this.log(lvl as any, msg));
    }
  }

  /** DM-callable commands shown in `help`. */
  override getCommands(): Record<string, CommandDef> {
    return {
      status: { description: "feishu 连接状态 + 当前默认 adapter + mapping 数" },
      list: { description: "列出所有飞书会话 ↔ nerve 频道映射" },
      agent: {
        description: "切换新会话默认 adapter（已有 mapping 不变）",
        args: { name: "codex | gemini | claude" },
      },
      clear: {
        description: "清掉 mapping。不带参数清全部，带参数清单个",
        args: { chat: "可选：feishuChatId（如 oc_xxx）" },
      },
    };
  }

  /**
   * Route incoming node.message:
   *   - from a known AI agent (codex-feishu-* / gemini-feishu-*) → forward to feishu
   *   - else → treat as DM command (PluginBase default flow)
   *
   * The base class registers a `node.message` handler that calls dispatchCommand;
   * we hook in here to make agent replies bypass command parsing.
   */
  protected override dispatchCommand(content: string, from?: string, channelId?: string): void {
    if (from && this.core?.isKnownAgent(from)) {
      this.core.handleNodeMessage({ content, from });
      return;
    }
    super.dispatchCommand(content, from, channelId);
  }

  override onCommand(command: string, args: Record<string, string>, from?: string): CommandResult {
    if (!this.core) return { error: "bridge not ready" };

    switch (command) {
      case "status": {
        const adapter = this.core.currentDefaultAdapter();
        const count = this.core.listMappings().length;
        const reply = `feishu-bridge OK · default-adapter=${adapter} · mappings=${count}`;
        this.log("info", `[cmd:status from=${from || "-"}] ${reply}`);
        return { reply };
      }

      case "list": {
        const all = this.core.listMappings();
        if (all.length === 0) {
          const reply = "(no mappings)";
          this.log("info", `[cmd:list from=${from || "-"}] ${reply}`);
          return { reply };
        }
        const lines = all.map(m =>
          `${m.feishuChatId}  →  ${m.agentName}  (adapter=${m.agentAdapter || "?"})  ch=${m.channelId}`
        );
        const reply = lines.join("\n");
        this.log("info", `[cmd:list from=${from || "-"}]\n${reply}`);
        return { reply };
      }

      case "agent": {
        const name = args.name || args["0"];
        const allowed = this.core.allowedAdapters();
        if (!name) return { error: `usage: agent <${allowed.join(" | ")}>` };
        if (!allowed.includes(name)) {
          return { error: `adapter "${name}" 不在白名单。可选: ${allowed.join(", ")}` };
        }
        // Validated synchronously; persist async (errors logged)
        this.core.setDefaultAdapter(name).then(() => {
          this.log("info", `[cmd:agent] default adapter → ${name}`);
        }).catch(err => {
          this.log("warn", `[cmd:agent] persist failed: ${err?.message || err}`);
        });
        return { reply: `default adapter → ${name} (新会话生效，已有 mapping 不变)` };
      }

      case "clear": {
        const chat = args.chat || args["0"];
        if (!chat) {
          this.core.clearAllMappings().then(n => {
            this.log("info", `[cmd:clear all] dropped ${n} mappings`);
          }).catch(err => this.log("warn", `[cmd:clear all] ${err}`));
          return { reply: `已清全部 mapping（重启时不再 re-join 旧频道）` };
        }
        this.core.clearMapping(chat).then(ok => {
          this.log("info", `[cmd:clear ${chat}] ${ok ? "dropped" : "not found"}`);
        }).catch(err => this.log("warn", `[cmd:clear ${chat}] ${err}`));
        return { reply: `已尝试清 mapping: ${chat}` };
      }
    }
  }

  protected override async onReady(): Promise<void> {
    const transport: NerveTransport = {
      request: (method, params) => this.request(method, params || {}),
    };
    const mapping = new MappingStore(this.mappingPath, (msg) => this.log("warn", msg));
    this.core = new BridgeCore({
      transport,
      feishu: this.client,
      mapping,
      agentAdapter: this.agentAdapter,
      bridgeNodeName: "feishu-bridge",
      log: (lvl, msg) => this.log(lvl, msg),
    });

    // Auto-join channels we already own (so reconnect doesn't lose membership
    // and @feishu-bridge mentions can still route to us).
    for (const m of mapping.all()) {
      try {
        await this.request("channel.join", { channelId: m.channelId });
        this.log("info", `re-joined channel ${m.channelId} (feishu ${m.feishuChatId})`);
      } catch (err: any) {
        this.log("warn", `re-join channel ${m.channelId} failed: ${err?.message || err}`);
      }
    }

    await this.client.start(async (evt) => {
      await this.core!.handleFeishuMessage(evt);
    });
    this.log("info",
      `feishu-bridge ready (default-adapter=${this.core.currentDefaultAdapter()}, ` +
      `mappings=${mapping.all().length})`);
  }

  /** Convenience for tests / explicit teardown */
  async shutdown(): Promise<void> {
    try { await this.client.stop(); } catch {}
    this.stop();
  }

  /** Convenience for tests */
  getMapping(feishuChatId: string) {
    return this.core?.getMapping(feishuChatId);
  }
}

// --- Main ---
if (process.argv[1] && process.argv[1].endsWith("feishu-bridge/index.ts")) {
  const bridge = new FeishuBridge({
    port: PORT,
    configPath: CONFIG_PATH,
    agentAdapter: AGENT_ADAPTER,
  });

  bridge.start().catch((err) => {
    console.error(`[feishu-bridge] failed to start: ${err}`);
    process.exit(1);
  });

  const shutdown = async () => {
    await bridge.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });
}
