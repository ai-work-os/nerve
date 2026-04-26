#!/usr/bin/env node
/**
 * Nerve Channel CLI — unified entry point for server and management commands.
 *
 * Usage:
 *   nerve serve [--port 4800] [--data DIR] [--event-log FILE]
 *   nerve status
 *   nerve channel list|create|close|history|post
 *   nerve node list|spawn|stop
 */

import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";

const DEFAULT_PORT = 4800;
const BASE_URL = process.env.NERVE_URL || `http://localhost:${DEFAULT_PORT}`;

// --- HTTP client ---

function post(path: string, data: Record<string, unknown> = {}): Promise<any> {
  const url = new URL(path, BASE_URL);
  const body = JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); }
      });
    });
    req.on("error", (e) => reject(new Error(`Cannot connect to Nerve server: ${e.message}`)));
    req.write(body);
    req.end();
  });
}

function get(path: string): Promise<any> {
  const url = new URL(path, BASE_URL);
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); }
      });
    }).on("error", (e) => reject(new Error(`Cannot connect to Nerve server: ${e.message}`)));
  });
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

// --- Commands ---

async function cmdServe(args: string[]) {
  let port = DEFAULT_PORT;
  let dataDir = resolve(homedir(), ".nerve");
  let eventLogPath: string | undefined;
  let noGuardian = false;
  let noRecorder = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) { port = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === "--data" && args[i + 1]) { dataDir = resolve(args[i + 1]); i++; }
    else if (args[i] === "--event-log" && args[i + 1]) { eventLogPath = resolve(args[i + 1]); i++; }
    else if (args[i] === "--no-guardian") { noGuardian = true; }
    else if (args[i] === "--no-recorder") { noRecorder = true; }
  }

  // Dynamic import to avoid loading heavy deps for simple commands
  const { initLog, info, closeLog } = await import("./logger.js");
  const logFile = resolve(dataDir, "nerve.log");
  initLog(logFile);

  const { ChannelManager } = await import("./channel-manager.js");
  const { Server } = await import("./server.js");

  const nerve = new ChannelManager({ dataDir, port, eventLogPath });
  const server = new Server(nerve, port);
  server.start();

  // Auto-start context-guardian plugin via program node path
  let guardianNodeId: string | undefined;

  if (!noGuardian) {
    const startGuardian = () => {
      const result = nerve.cleanupStaleGuardian("context-guardian");
      if (result === "alive") {
        info("guardian already running, skipping spawn");
        return;
      }

      try {
        const node = nerve.nodePool.spawnProcessSync("guardian", "context-guardian", resolve(dataDir), port);
        guardianNodeId = node.id;
        info(`guardian spawned as program node (nodeId: ${node.id})`);
      } catch (err: any) {
        info(`guardian spawn failed: ${err.message}`);
      }
    };

    startGuardian();
  }

  // Auto-start user-recorder plugin via program node path
  let recorderNodeId: string | undefined;

  if (!noRecorder) {
    const startRecorder = () => {
      const result = nerve.cleanupStaleGuardian("user-recorder");
      if (result === "alive") {
        info("user-recorder already running, skipping spawn");
        return;
      }

      try {
        const node = nerve.nodePool.spawnProcessSync("user-recorder", "user-recorder", resolve(dataDir), port);
        recorderNodeId = node.id;
        info(`user-recorder spawned as program node (nodeId: ${node.id})`);
      } catch (err: any) {
        info(`user-recorder spawn failed: ${err.message}`);
      }
    };

    startRecorder();
  }

  const shutdown = async () => {
    try {
      info("shutting down...");
      if (guardianNodeId) {
        try { await nerve.nodePool.stopNode(guardianNodeId); } catch (e) { info(`guardian stop failed: ${e}`); }
        info("guardian stopped");
      }
      if (recorderNodeId) {
        try { await nerve.nodePool.stopNode(recorderNodeId); } catch (e) { info(`user-recorder stop failed: ${e}`); }
        info("user-recorder stopped");
      }
      await server.shutdown();
      closeLog();
    } catch (err: any) {
      info(`shutdown error: ${err.message}`);
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function cmdStatus() {
  try {
    const health = await get("/health");
    const nodes = await post("/node/list");
    const channels = await post("/channel/list");
    console.log(`Nerve: ${health.status}`);
    if (health.logFile) console.log(`Log: ${health.logFile}`);
    console.log(`Nodes: ${nodes.nodes?.length || 0}`);
    for (const n of nodes.nodes || []) {
      console.log(`  ${n.name} [${n.status}] ${n.transport} ${n.adapter || ""}`);
    }
    console.log(`Channels: ${channels.channels?.length || 0}`);
    for (const ch of channels.channels || []) {
      const nodeNames = Object.keys(ch.nodes || {});
      console.log(`  ${ch.id} ${ch.name || "(unnamed)"} [${nodeNames.join(", ") || "empty"}]`);
    }
  } catch (e: any) {
    die(e.message);
  }
}

async function cmdLog(args: string[]) {
  let tail = 50;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tail" && args[i + 1]) { tail = parseInt(args[i + 1]); i++; }
    else if (args[i] === "-f") {
      // Follow mode — just cat the log path
      const health = await get("/health");
      if (health.logFile) {
        console.log(health.logFile);
      } else {
        die("no log file");
      }
      return;
    }
  }
  try {
    const url = `/log?tail=${tail}`;
    const result = await new Promise<string>((resolve, reject) => {
      const u = new URL(url, BASE_URL);
      http.get(u, (res) => {
        let d = "";
        res.on("data", (c) => d += c);
        res.on("end", () => resolve(d));
      }).on("error", reject);
    });
    process.stdout.write(result);
  } catch (e: any) {
    die(e.message);
  }
}

async function cmdChannel(sub: string, args: string[]) {
  try {
    switch (sub) {
      case "list": case "ls": {
        const r = await post("/channel/list");
        for (const ch of r.channels || []) {
          const nodes = Object.keys(ch.nodes || {});
          console.log(`${ch.id}  ${ch.name || "(unnamed)"}  cwd=${ch.cwd}  nodes=[${nodes.join(",")}]`);
        }
        if (!r.channels?.length) console.log("(no channels)");
        break;
      }
      case "create": {
        let cwd = process.cwd(), name: string | undefined;
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--cwd" && args[i + 1]) { cwd = args[i + 1]; i++; }
          else if (args[i] === "--name" && args[i + 1]) { name = args[i + 1]; i++; }
          else if (!name) name = args[i]; // positional: name
        }
        const r = await post("/channel/create", { cwd, name });
        console.log(r.channelId);
        break;
      }
      case "close": {
        const channelId = args[0];
        if (!channelId) die("Usage: nerve channel close <channelId>");
        await post("/channel/close", { channelId });
        console.log("ok");
        break;
      }
      case "history": case "hist": {
        const channelId = args[0];
        if (!channelId) die("Usage: nerve channel history <channelId> [--limit N]");
        let limit = 20;
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1]); i++; }
        }
        const r = await post("/channel/history", { channelId, limit });
        for (const m of r.messages || []) {
          const t = new Date(m.timestamp).toLocaleTimeString();
          console.log(`[${t}] ${m.from}: ${m.content}`);
        }
        break;
      }
      case "post": {
        let channelId: string | undefined, from: string | undefined;
        const contentParts: string[] = [];
        // First pass: extract flags
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--from" && args[i + 1]) { from = args[i + 1]; i++; }
          else if (args[i] === "--channel" && args[i + 1]) { channelId = args[i + 1]; i++; }
          else if (!channelId) channelId = args[i];
          else contentParts.push(args[i]);
        }
        const content = contentParts.join(" ");
        if (!channelId || !content) die("Usage: nerve channel post <channelId> <message> [--from NAME]");
        const r = await post("/channel/post", { channelId, from: from || "cli", content });
        if (r.error) die(r.error);
        console.log("ok");
        break;
      }
      default:
        die(`Unknown: nerve channel ${sub}\nCommands: list, create, close, history, post`);
    }
  } catch (e: any) {
    die(e.message);
  }
}

async function cmdNode(sub: string, args: string[]) {
  try {
    switch (sub) {
      case "list": case "ls": {
        const r = await post("/node/list");
        for (const n of r.nodes || []) {
          console.log(`${n.id}  ${n.name}  [${n.status}]  ${n.transport}  ${n.adapter || ""}`);
        }
        if (!r.nodes?.length) console.log("(no nodes)");
        break;
      }
      case "spawn": {
        const adapter = args[0];
        if (!adapter) die("Usage: nerve node spawn <adapter> [--name NAME] [--cwd DIR] [--model MODEL]");
        let name: string | undefined, cwd: string | undefined, model: string | undefined;
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--name" && args[i + 1]) { name = args[i + 1]; i++; }
          else if (args[i] === "--cwd" && args[i + 1]) { cwd = args[i + 1]; i++; }
          else if (args[i] === "--model" && args[i + 1]) { model = args[i + 1]; i++; }
        }
        const r = await post("/node/spawn", { adapter, name, cwd, model });
        if (r.error) die(r.error);
        console.log(`${r.nodeId}  ${r.name}  [${r.status}]`);
        break;
      }
      case "join": {
        const nodeName = args[0];
        const channelId = args[1];
        if (!nodeName || !channelId) die("Usage: nerve node join <nodeName> <channelId>");
        const r = await post("/node/join", { nodeName, channelId });
        if (r.error) die(r.error);
        console.log("ok");
        break;
      }
      case "leave": {
        const nodeName = args[0];
        const channelId = args[1];
        if (!nodeName || !channelId) die("Usage: nerve node leave <nodeName> <channelId>");
        const r = await post("/node/leave", { nodeName, channelId });
        if (r.error) die(r.error);
        console.log("ok");
        break;
      }
      case "stop": {
        const target = args[0];
        if (!target) die("Usage: nerve node stop <nodeId|nodeName>");
        const r = await post("/node/stop", target.length === 12 ? { nodeId: target } : { nodeName: target });
        if (r.error) die(r.error);
        console.log("ok");
        break;
      }
      default:
        die(`Unknown: nerve node ${sub}\nCommands: list, spawn, join, leave, stop`);
    }
  } catch (e: any) {
    die(e.message);
  }
}

async function cmdScene(sub: string, args: string[]) {
  try {
    switch (sub) {
      case "list": case "ls": {
        const r = await post("/scene/list");
        for (const s of r.scenes || []) {
          const status = s.running ? " [运行中]" : "";
          console.log(`  ${s.name}${status}  (${s.file})`);
        }
        if (!r.scenes?.length) console.log("(no scenes)");
        break;
      }
      case "start": {
        const name = args[0];
        if (!name) die("Usage: nerve scene start <name> [--cwd DIR]");
        let cwd: string | undefined;
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--cwd" && args[i + 1]) { cwd = args[i + 1]; i++; }
        }
        const r = await post("/scene/start", { name, cwd });
        if (r.error) die(r.error);
        console.log(`场景 ${r.name} 已启动`);
        if (r.channelId) console.log(`频道: ${r.channelId}`);
        if (r.nodeIds?.length) console.log(`节点: ${r.nodeIds.join(", ")}`);
        break;
      }
      case "stop": {
        const name = args[0];
        if (!name) die("Usage: nerve scene stop <name>");
        const r = await post("/scene/stop", { name });
        if (r.error) die(r.error);
        console.log("ok");
        break;
      }
      default:
        die(`Unknown: nerve scene ${sub}\nCommands: list, start, stop`);
    }
  } catch (e: any) {
    die(e.message);
  }
}

function showHelp() {
  console.log(`nerve — Nerve CLI

Commands:
  serve [--port 4800] [--data DIR] [--no-guardian]
                                         Start the Nerve server
  status                                 Show server status

  channel list                           List channels
  channel create [NAME] [--cwd DIR]      Create a channel
  channel close <ID>                     Close a channel
  channel history <ID> [--limit 20]      Show message history
  channel post <ID> <message> [--from X] Post a message

  node list                              List nodes
  node spawn <adapter> [--name N] [--model M] Spawn an agent
  node join <name> <channelId>           Join agent to channel
  node leave <name> <channelId>          Remove agent from channel
  node stop <ID|name>                    Stop a node

  scene list                             List available scenes
  scene start <name> [--cwd DIR]         Start a scene
  scene stop <name>                      Stop a running scene

  bridge [--sock ADDR] [--channel ID]    Connect nvim to a channel

  log [--tail 50]                        Show recent logs
  log -f                                 Print log file path (for tail -f)

Environment:
  NERVE_URL    Server URL (default: http://localhost:4800)`);
}

// --- Main ---

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === "--help" || cmd === "-h") {
  showHelp();
} else if (cmd === "serve" || cmd === "server") {
  void cmdServe(argv.slice(1));
} else if (cmd === "status" || cmd === "st") {
  void cmdStatus();
} else if (cmd === "channel" || cmd === "ch") {
  const sub = argv[1];
  if (!sub) die("Usage: nerve channel <list|create|close|history|post>");
  void cmdChannel(sub, argv.slice(2));
} else if (cmd === "node" || cmd === "n") {
  const sub = argv[1];
  if (!sub) die("Usage: nerve node <list|spawn|stop>");
  void cmdNode(sub, argv.slice(2));
} else if (cmd === "post") {
  // Shortcut: nerve post <channelId> <message> [--from X]
  void cmdChannel("post", argv.slice(1));
} else if (cmd === "log") {
  void cmdLog(argv.slice(1));
} else if (cmd === "bridge" || cmd === "br") {
  import("./nvim-bridge.js").then(m => m.main(argv.slice(1))).catch(err => die(`bridge error: ${err.message}`));
} else if (cmd === "scene" || cmd === "sc") {
  const sub = argv[1];
  if (!sub) die("Usage: nerve scene <list|start|stop> [name]");
  void cmdScene(sub, argv.slice(2));
} else if (cmd === "--port") {
  // Legacy: nerve --port 4800 → treat as serve
  void cmdServe(argv);
} else {
  die(`Unknown command: ${cmd}\nRun 'nerve --help' for usage.`);
}
