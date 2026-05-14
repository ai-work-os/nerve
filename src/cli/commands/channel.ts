/**
 * `nerve channel <sub>` — channel management commands.
 *
 * Subcommands mirror /channel/* HTTP endpoints. See API.md for shape details.
 */

import { post, emit, die, checkErr } from "../http.js";

const SUBS = [
  "list", "ls", "create", "close", "delete", "history", "hist",
  "post", "members", "addNode", "removeNode", "listArchived", "restore",
];

export function help(): string {
  return `nerve channel <sub> [args]

Subcommands:
  list [--cwd DIR]                       List active channels (alias: ls)
  create [NAME] [--cwd DIR]              Create a channel
  close <channelId>                      Mark channel inactive (kept in DB)
  delete <channelId>                     Hard-delete channel + messages
  history <channelId> [--limit 20]       Show message history (alias: hist)
  post <channelId> <message> [--from N]  Post a message
  members --channel <channelId>          List members of a channel
  members --node <nodeName>              List channels & members for a node
  addNode <channelId> <nodeId> [--name N]  Add a node to a channel
  removeNode <channelId> <nodeName>      Remove a node
  listArchived [--cwd DIR] [--query Q]   List archived channels
  restore <channelId>                    Restore an archived channel`;
}

export async function run(sub: string, args: string[]): Promise<void> {
  switch (sub) {
    case "list":
    case "ls": {
      let cwd: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--cwd" && args[i + 1]) { cwd = args[i + 1]; i++; }
      }
      const r = await post("/channel/list", cwd ? { cwd } : {});
      emit(r, (x) => {
        if (!x.channels?.length) return "(no channels)";
        return x.channels.map((ch: any) => {
          const nodes = Object.keys(ch.nodes || {});
          return `${ch.id}  ${ch.name || "(unnamed)"}  cwd=${ch.cwd}  nodes=[${nodes.join(",")}]`;
        }).join("\n");
      });
      return;
    }
    case "create": {
      let cwd = process.cwd(), name: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--cwd" && args[i + 1]) { cwd = args[i + 1]; i++; }
        else if (args[i] === "--name" && args[i + 1]) { name = args[i + 1]; i++; }
        else if (!name) name = args[i];
      }
      const r = await post("/channel/create", { cwd, name });
      checkErr(r, "channel create");
      emit(r, (x) => x.channelId);
      return;
    }
    case "close": {
      const channelId = args[0];
      if (!channelId) die("usage: nerve channel close <channelId>");
      const r = await post("/channel/close", { channelId });
      checkErr(r, "channel close");
      emit(r, () => "ok");
      return;
    }
    case "delete": {
      const channelId = args[0];
      if (!channelId) die("usage: nerve channel delete <channelId>");
      const r = await post("/channel/delete", { channelId });
      checkErr(r, "channel delete");
      emit(r, () => "ok");
      return;
    }
    case "history":
    case "hist": {
      const channelId = args[0];
      if (!channelId) die("usage: nerve channel history <channelId> [--limit N] [--before TS]");
      let limit = 20;
      let before: number | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1]); i++; }
        else if (args[i] === "--before" && args[i + 1]) { before = parseInt(args[i + 1]); i++; }
      }
      const r = await post("/channel/history", { channelId, limit, before });
      checkErr(r, "channel history");
      emit(r, (x) => (x.messages || []).map((m: any) =>
        `[${new Date(m.timestamp).toISOString()}] ${m.from}: ${m.content}`
      ).join("\n"));
      return;
    }
    case "post": {
      let channelId: string | undefined, from: string | undefined;
      const contentParts: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--from" && args[i + 1]) { from = args[i + 1]; i++; }
        else if (args[i] === "--channel" && args[i + 1]) { channelId = args[i + 1]; i++; }
        else if (!channelId) channelId = args[i];
        else contentParts.push(args[i]);
      }
      const content = contentParts.join(" ");
      if (!channelId || !content) die("usage: nerve channel post <channelId> <message> [--from NAME]");
      const r = await post("/channel/post", { channelId, from: from || "cli", content });
      checkErr(r, "channel post");
      emit(r, () => "ok");
      return;
    }
    case "members": {
      let channelId: string | undefined, nodeName: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if ((args[i] === "--channel" || args[i] === "-c") && args[i + 1]) { channelId = args[i + 1]; i++; }
        else if ((args[i] === "--node" || args[i] === "-n") && args[i + 1]) { nodeName = args[i + 1]; i++; }
        else if (!channelId && !nodeName) channelId = args[i];
      }
      if (!channelId && !nodeName) die("usage: nerve channel members --channel <id> | --node <name>");
      const r = await post("/channel/members", { channelId, nodeName });
      checkErr(r, "channel members");
      emit(r, (x) => {
        if (x.members) return x.members.map((m: any) => `${m.name}\t${m.nodeId}\t${m.status}`).join("\n");
        if (x.channels) return x.channels.map((c: any) =>
          `${c.channel_id}\t${c.name || ""}\n` + c.members.map((m: any) => `  ${m.name}\t${m.status}`).join("\n")
        ).join("\n");
        return "(no members)";
      });
      return;
    }
    case "addNode": {
      const channelId = args[0];
      const nodeId = args[1];
      let nodeName: string | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--name" && args[i + 1]) { nodeName = args[i + 1]; i++; }
      }
      if (!channelId || !nodeId) die("usage: nerve channel addNode <channelId> <nodeId> [--name NAME]");
      const r = await post("/channel/addNode", { channelId, nodeId, nodeName });
      checkErr(r, "channel addNode");
      emit(r, () => "ok");
      return;
    }
    case "removeNode": {
      const channelId = args[0];
      const nodeName = args[1];
      if (!channelId || !nodeName) die("usage: nerve channel removeNode <channelId> <nodeName>");
      const r = await post("/channel/removeNode", { channelId, nodeName });
      checkErr(r, "channel removeNode");
      emit(r, () => "ok");
      return;
    }
    case "listArchived": {
      let cwd: string | undefined, query: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--cwd" && args[i + 1]) { cwd = args[i + 1]; i++; }
        else if (args[i] === "--query" && args[i + 1]) { query = args[i + 1]; i++; }
      }
      const r = await post("/channel/listArchived", { cwd, query });
      checkErr(r, "channel listArchived");
      emit(r, (x) => (x.channels || []).map((c: any) =>
        `${c.id}\t${c.name || "(unnamed)"}\t${c.cwd}\tmsgs=${c.memberCount}`
      ).join("\n"));
      return;
    }
    case "restore": {
      const channelId = args[0];
      if (!channelId) die("usage: nerve channel restore <channelId>");
      const r = await post("/channel/restore", { channelId });
      checkErr(r, "channel restore");
      emit(r, (x) => `restored: ${x.channelId} (${x.messages?.length || 0} messages)`);
      return;
    }
    default:
      die(`unknown subcommand: nerve channel ${sub}\n${help()}`);
  }
}

export { SUBS };
