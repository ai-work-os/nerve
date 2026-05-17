#!/usr/bin/env node
/**
 * Nerve CLI — unified entry point.
 *
 * Server bootstrap:
 *   nerve serve [--port N] [--data DIR] [--event-log F] [--no-*]
 *
 * Client commands (use HTTP API, AI-friendly JSON output by default):
 *   nerve [-H host] [--human] <namespace> <action> [args]
 *
 * Namespaces: channel, node, session, scene, peer, remote, dm
 * Top-level shortcuts: status, log, health, metrics, blob, bridge, post
 *
 * See `nerve --help` for the full command list and `~/.config/nerve/hosts.json`
 * for host alias configuration.
 */

import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { setBaseUrl, setOutputMode } from "./cli/http.js";
import { extractHostFlag, extractOutputFlag, resolveHost } from "./cli/host-resolver.js";

const DEFAULT_PORT = 4800;

// --- Server bootstrap (heavy: dynamic imports inside) ---

async function cmdServe(args: string[]) {
  let port = DEFAULT_PORT;
  let dataDir = resolve(homedir(), ".nerve");
  let eventLogPath: string | undefined;
  let noGuardian = false;
  let noDuty = false;
  let noLifeLog = false;
  let noFeishu = false;
  let noEmailWatcher = false;
  let noWatchdog = false;
  let noScreenshot = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) { port = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === "--data" && args[i + 1]) { dataDir = resolve(args[i + 1]); i++; }
    else if (args[i] === "--event-log" && args[i + 1]) { eventLogPath = resolve(args[i + 1]); i++; }
    else if (args[i] === "--no-guardian") { noGuardian = true; }
    else if (args[i] === "--no-recorder") { /* deprecated no-op: user-recorder no longer auto-starts */ }
    else if (args[i] === "--no-duty") { noDuty = true; }
    else if (args[i] === "--no-life-log") { noLifeLog = true; }
    else if (args[i] === "--no-feishu") { noFeishu = true; }
    else if (args[i] === "--no-email-watcher") { noEmailWatcher = true; }
    else if (args[i] === "--no-watchdog") { noWatchdog = true; }
    else if (args[i] === "--no-screenshot") { noScreenshot = true; }
  }

  const { initLog, info, closeLog } = await import("./infra/logger.js");
  const logFile = resolve(dataDir, "nerve.log");
  initLog(logFile);

  const { ChannelManager } = await import("./channel/channel-manager.js");
  const { Server } = await import("./server.js");
  const { startStartupScenes } = await import("./scene/startup.js");

  const nerve = new ChannelManager({ dataDir, port, eventLogPath });
  const server = new Server(nerve, port);
  server.start();

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

  let dutyNodeId: string | undefined;
  if (!noDuty) {
    const startDuty = () => {
      const result = nerve.cleanupStaleGuardian("duty-monitor");
      if (result === "alive") {
        info("duty-monitor already running, skipping spawn");
        return;
      }
      try {
        const node = nerve.nodePool.spawnProcessSync("duty-monitor", "duty-monitor", resolve(dataDir), port);
        dutyNodeId = node.id;
        info(`duty-monitor spawned as program node (nodeId: ${node.id})`);
      } catch (err: any) {
        info(`duty-monitor spawn failed: ${err.message}`);
      }
    };
    startDuty();
  }

  let lifeLogNodeId: string | undefined;
  const lifeLogRemoteUpload = process.env.AI_LIFE_LOG_REMOTE_UPLOAD === "true";
  const lifeLogShouldStart = !noLifeLog && (process.platform === "darwin" || lifeLogRemoteUpload);
  if (lifeLogShouldStart) {
    const startLifeLog = () => {
      const result = nerve.cleanupStaleGuardian("ai-life-log");
      if (result === "alive") {
        info("ai-life-log already running, skipping spawn");
        return;
      }
      try {
        const node = nerve.nodePool.spawnProcessSync("ai-life-log", "ai-life-log", resolve(dataDir), port);
        lifeLogNodeId = node.id;
        info(`ai-life-log spawned as program node (nodeId: ${node.id})`);
      } catch (err: any) {
        info(`ai-life-log spawn failed: ${err.message}`);
      }
    };
    startLifeLog();
  } else if (!noLifeLog) {
    info(`ai-life-log skipped (platform=${process.platform}, AI_LIFE_LOG_REMOTE_UPLOAD!=true)`);
  }

  let feishuBridgeNodeId: string | undefined;
  const feishuConfigPath = resolve(homedir(), ".nerve/feishu.json");
  const feishuShouldStart = !noFeishu && existsSync(feishuConfigPath);
  if (feishuShouldStart) {
    const startFeishu = () => {
      const result = nerve.cleanupStaleGuardian("feishu-bridge");
      if (result === "alive") {
        info("feishu-bridge already running, skipping spawn");
        return;
      }
      try {
        const node = nerve.nodePool.spawnProcessSync("feishu-bridge", "feishu-bridge", resolve(dataDir), port);
        feishuBridgeNodeId = node.id;
        info(`feishu-bridge spawned as program node (nodeId: ${node.id})`);
      } catch (err: any) {
        info(`feishu-bridge spawn failed: ${err.message}`);
      }
    };
    startFeishu();
  } else if (!noFeishu) {
    info(`feishu-bridge skipped (no ${feishuConfigPath})`);
  }

  let emailWatcherNodeId: string | undefined;
  const emailAccountsPath = resolve(homedir(), ".config/email-watcher/accounts.json");
  const emailWatcherShouldStart = !noEmailWatcher && existsSync(emailAccountsPath);
  if (emailWatcherShouldStart) {
    const startEmailWatcher = () => {
      const result = nerve.cleanupStaleGuardian("email-watcher");
      if (result === "alive") {
        info("email-watcher already running, skipping spawn");
        return;
      }
      try {
        const node = nerve.nodePool.spawnProcessSync("email-watcher", "email-watcher", resolve(dataDir), port);
        emailWatcherNodeId = node.id;
        info(`email-watcher spawned as program node (nodeId: ${node.id})`);
      } catch (err: any) {
        info(`email-watcher spawn failed: ${err.message}`);
      }
    };
    startEmailWatcher();
  } else if (!noEmailWatcher) {
    info(`email-watcher skipped (no ${emailAccountsPath})`);
  }

  let watchdogNodeId: string | undefined;
  if (!noWatchdog) {
    const startWatchdog = () => {
      const result = nerve.cleanupStaleGuardian("system-watchdog");
      if (result === "alive") {
        info("system-watchdog already running, skipping spawn");
        return;
      }
      try {
        const node = nerve.nodePool.spawnProcessSync("system-watchdog", "system-watchdog", resolve(dataDir), port);
        watchdogNodeId = node.id;
        info(`system-watchdog spawned as program node (nodeId: ${node.id})`);
      } catch (err: any) {
        info(`system-watchdog spawn failed: ${err.message}`);
      }
    };
    startWatchdog();
  }

  let screenshotNodeId: string | undefined;
  if (!noScreenshot) {
    const startScreenshot = () => {
      const result = nerve.cleanupStaleGuardian("screenshot");
      if (result === "alive") {
        info("screenshot already running, skipping spawn");
        return;
      }
      try {
        const node = nerve.nodePool.spawnProcessSync("screenshot", "screenshot", resolve(dataDir), port);
        screenshotNodeId = node.id;
        info(`screenshot spawned as program node (nodeId: ${node.id})`);
      } catch (err: any) {
        info(`screenshot spawn failed: ${err.message}`);
      }
    };
    startScreenshot();
  }

  void startStartupScenes({
    dataDir,
    startScene: (name: string) => server.startScene(name),
    log: info,
  });

  const shutdown = async () => {
    try {
      info("shutting down...");
      if (guardianNodeId) {
        try { await nerve.nodePool.stopNode(guardianNodeId); } catch (e) { info(`guardian stop failed: ${e}`); }
        info("guardian stopped");
      }
      if (dutyNodeId) {
        try { await nerve.nodePool.stopNode(dutyNodeId); } catch (e) { info(`duty-monitor stop failed: ${e}`); }
        info("duty-monitor stopped");
      }
      if (lifeLogNodeId) {
        try { await nerve.nodePool.stopNode(lifeLogNodeId); } catch (e) { info(`ai-life-log stop failed: ${e}`); }
        info("ai-life-log stopped");
      }
      if (feishuBridgeNodeId) {
        try { await nerve.nodePool.stopNode(feishuBridgeNodeId); } catch (e) { info(`feishu-bridge stop failed: ${e}`); }
        info("feishu-bridge stopped");
      }
      if (emailWatcherNodeId) {
        try { await nerve.nodePool.stopNode(emailWatcherNodeId); } catch (e) { info(`email-watcher stop failed: ${e}`); }
        info("email-watcher stopped");
      }
      if (watchdogNodeId) {
        try { await nerve.nodePool.stopNode(watchdogNodeId); } catch (e) { info(`system-watchdog stop failed: ${e}`); }
        info("system-watchdog stopped");
      }
      if (screenshotNodeId) {
        try { await nerve.nodePool.stopNode(screenshotNodeId); } catch (e) { info(`screenshot stop failed: ${e}`); }
        info("screenshot stopped");
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

// --- Help text ---

function showHelp() {
  console.log(`nerve — Nerve CLI (debug-oriented; JSON output by default)

Global flags:
  -H, --host <alias|URL>   Target nerve instance (default: NERVE_URL env or localhost:4800)
                           Aliases configured in ~/.config/nerve/hosts.json
  --human                  Human-readable output (default is JSON)
  --json                   Force JSON output

Server:
  serve [--port 4800] [--data DIR] [--no-guardian] [--no-duty] [--no-life-log] [--no-feishu] [--no-email-watcher] [--no-screenshot]

Top-level:
  status                                Show server + nodes + channels summary
  health                                Server health check
  metrics                               Memory + process metrics
  log [--tail N] [-f|--follow]          Show recent server logs
  blob <blobId>                         Fetch blob content
  bridge [--sock ADDR] [--channel ID]   Connect nvim to a channel
  post <channelId> <msg> [--from N]     Shortcut for: channel post

Namespaces (run "nerve <ns>" without args for full subcommand list):
  channel    11 subcommands (list, create, close, delete, history, post,
             members, addNode, removeNode, listArchived, restore)
  node       9 subcommands (list, spawn, join, leave, stop, command, message,
             cancel, capabilities)
  session    5 subcommands (list, load, clear, compact, reset)
  scene      3 subcommands (list, start, stop)
  peer       4 subcommands (health, remote-spawn, remote-prompt, remote-reply)
  remote     1 subcommand  (spawn)
  dm         2 subcommands (read, send)

Environment:
  NERVE_URL    Full server URL override (e.g. http://localhost:4801)
  NERVE_HOST   Host alias from hosts.json (e.g. "home", "dev")

Examples:
  nerve -H home node list
  nerve dm read duty-monitor --limit 5
  nerve node command duty-monitor trigger --args name=erp-notes-reorganize
  nerve session clear codex-1
  nerve --human channel list`);
}

// --- Main dispatch ---

async function main(argv: string[]): Promise<void> {
  // Parse global flags first
  try {
    const explicit = extractHostFlag(argv);
    if (explicit) setBaseUrl(explicit);
    else setBaseUrl(resolveHost(undefined));
  } catch (e: any) {
    console.error(JSON.stringify({ error: e.message }));
    process.exit(1);
  }
  const mode = extractOutputFlag(argv);
  setOutputMode(mode);

  const cmd = argv[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    showHelp();
    return;
  }

  try {
    switch (cmd) {
      case "serve":
      case "server":
        await cmdServe(argv.slice(1));
        return;

      case "--port":
        // legacy: nerve --port 4800
        await cmdServe(argv);
        return;

      case "status":
      case "st": {
        const { status } = await import("./cli/commands/misc.js");
        await status();
        return;
      }

      case "health": {
        const { health } = await import("./cli/commands/misc.js");
        await health();
        return;
      }

      case "metrics": {
        const { metrics } = await import("./cli/commands/misc.js");
        await metrics();
        return;
      }

      case "log": {
        const { log } = await import("./cli/commands/misc.js");
        await log(argv.slice(1));
        return;
      }

      case "blob": {
        const { blob } = await import("./cli/commands/misc.js");
        await blob(argv.slice(1));
        return;
      }

      case "channel":
      case "ch": {
        const sub = argv[1];
        const { run, help } = await import("./cli/commands/channel.js");
        if (!sub) { console.log(help()); return; }
        await run(sub, argv.slice(2));
        return;
      }

      case "node":
      case "n": {
        const sub = argv[1];
        const { run, help } = await import("./cli/commands/node.js");
        if (!sub) { console.log(help()); return; }
        await run(sub, argv.slice(2));
        return;
      }

      case "session":
      case "sess": {
        const sub = argv[1];
        const { run, help } = await import("./cli/commands/session.js");
        if (!sub) { console.log(help()); return; }
        await run(sub, argv.slice(2));
        return;
      }

      case "scene":
      case "sc": {
        const sub = argv[1];
        const { run, help } = await import("./cli/commands/scene.js");
        if (!sub) { console.log(help()); return; }
        await run(sub, argv.slice(2));
        return;
      }

      case "peer": {
        const sub = argv[1];
        const { run, help } = await import("./cli/commands/peer.js");
        if (!sub) { console.log(help()); return; }
        await run(sub, argv.slice(2));
        return;
      }

      case "remote":
      case "r": {
        const sub = argv[1];
        const { run, help } = await import("./cli/commands/remote.js");
        if (!sub) { console.log(help()); return; }
        await run(sub, argv.slice(2));
        return;
      }

      case "dm": {
        const sub = argv[1];
        const { run, help } = await import("./cli/commands/dm.js");
        if (!sub) { console.log(help()); return; }
        await run(sub, argv.slice(2));
        return;
      }

      case "post": {
        // shortcut: nerve post <channelId> <message> [--from X]
        const { run } = await import("./cli/commands/channel.js");
        await run("post", argv.slice(1));
        return;
      }

      case "bridge":
      case "br": {
        const m = await import("./integration/nvim-bridge.js");
        await m.main(argv.slice(1));
        return;
      }

      default:
        console.error(JSON.stringify({ error: `unknown command: ${cmd}`, hint: "run 'nerve --help'" }));
        process.exit(1);
    }
  } catch (e: any) {
    console.error(JSON.stringify({ error: e.message || String(e) }));
    process.exit(1);
  }
}

void main(process.argv.slice(2));
