#!/usr/bin/env node
/**
 * feishu-bridge — nerve plugin node that bridges a Feishu bot to nerve channels.
 *
 * Inbound: feishu im.message.receive_v1 → channel.post into a per-chat nerve channel.
 *          AI agent (codex by default) is spawned lazily and joined to the channel.
 * Outbound: channel.message from the bound agent → feishu im.v1.message.reply.
 *
 * Usage:
 *   NERVE_PORT=4800 npx tsx src/plugins/feishu-bridge/index.ts
 *
 * Options (env or argv):
 *   --port <n>           nerve WS port (default 4800; NERVE_PORT overrides)
 *   --config <path>      feishu config (default ~/.nerve/feishu.json)
 *   --agent <adapter>    AI adapter to spawn (default "codex")
 *
 * Credentials file ~/.nerve/feishu.json:
 *   { "app_id": "cli_xxx", "app_secret": "..." }
 */

import { resolve } from "node:path";

import { PluginBase } from "../plugin-base.js";
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

  /**
   * Override onMessage: every `node.message` ends up here (PluginBase dispatches
   * to onMessage when no commands are declared). That's the path codex's
   * `nerve_post({ to: "feishu-bridge", ... })` reply takes.
   */
  protected override onMessage(content: string, from?: string): void {
    this.core?.handleNodeMessage({ content, from });
  }

  override getHealth() {
    return { liveness: "process" as const, maxIdleMs: "none" as const, maxMemoryMB: 200 };
  }

  protected override async onReady(): Promise<void> {
    const transport: NerveTransport = {
      request: (method, params) => this.request(method, params || {}),
    };
    const mapping = new MappingStore(this.mappingPath);
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
    this.log("info", `feishu-bridge ready (agent=${this.agentAdapter}, mappings=${mapping.all().length})`);
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
