/**
 * Misc commands: status, log, health, metrics, blob.
 *
 * These don't fit a namespace; they're top-level shortcuts.
 */

import { post, get, getText, emit, die } from "../http.js";

export async function status(): Promise<void> {
  const health = await get("/health");
  const nodes = await post("/node/list");
  const channels = await post("/channel/list");
  const result = {
    status: health.status,
    logFile: health.logFile,
    nodes: nodes.nodes || [],
    channels: channels.channels || [],
  };
  emit(result, (x) => {
    const lines: string[] = [`status: ${x.status}`];
    if (x.logFile) lines.push(`log: ${x.logFile}`);
    lines.push(`nodes (${x.nodes.length}):`);
    for (const n of x.nodes) lines.push(`  ${n.name}\t[${n.status}]\t${n.transport}\t${n.adapter || ""}`);
    lines.push(`channels (${x.channels.length}):`);
    for (const ch of x.channels) {
      const nodeNames = Object.keys(ch.nodes || {});
      lines.push(`  ${ch.id}\t${ch.name || "(unnamed)"}\t[${nodeNames.join(", ") || "empty"}]`);
    }
    return lines.join("\n");
  });
}

export async function log(args: string[]): Promise<void> {
  let tail = 100;
  let follow = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tail" && args[i + 1]) { tail = parseInt(args[i + 1]); i++; }
    else if (args[i] === "-f" || args[i] === "--follow") { follow = true; }
  }
  if (follow) {
    const health = await get("/health");
    if (!health.logFile) die("no log file available");
    // Emit just the path so caller can `tail -f $(nerve log -f)`
    emit({ logFile: health.logFile }, (x) => x.logFile);
    return;
  }
  const content = await getText(`/log?tail=${tail}`);
  // log is plain text — write through verbatim regardless of mode
  process.stdout.write(content);
}

export async function health(): Promise<void> {
  const r = await get("/health");
  emit(r, (x) => `${x.status}${x.logFile ? `\tlog=${x.logFile}` : ""}`);
}

export async function metrics(): Promise<void> {
  const r = await get("/metrics");
  emit(r, (x) => {
    const lines: string[] = [
      `server uptime=${x.server.uptime.toFixed(1)}s rss=${(x.server.rss / 1024 / 1024).toFixed(1)}MB heap=${(x.server.heapUsed / 1024 / 1024).toFixed(1)}MB`,
    ];
    for (const n of x.nodes || []) {
      const rss = n.rss ? `${(n.rss / 1024 / 1024).toFixed(1)}MB` : "—";
      lines.push(`  ${n.name}\tpid=${n.pid ?? "—"}\trss=${rss}\t[${n.status}]`);
    }
    return lines.join("\n");
  });
}

export async function blob(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die("usage: nerve blob <blobId>");
  const content = await getText(`/blob/${id}`);
  process.stdout.write(content);
}
