/**
 * `nerve node <sub>` — process node management.
 *
 * Mirrors /node/* HTTP endpoints. The most important debug commands here are
 * `command` (trigger a program node command), `message` (DM a node),
 * `cancel` (interrupt an in-flight prompt), and `capabilities` (list all
 * available adapter commands).
 */

import { post, emit, die, checkErr, parseArgPairs } from "../http.js";

export function help(): string {
  return `nerve node <sub> [args]

Subcommands:
  list [--cwd DIR]                                       List nodes (alias: ls)
  spawn <adapter> [--name N] [--cwd D] [--model M]       Spawn an agent
  join <name> <channelId>                                Join agent to channel
  leave <name> <channelId>                               Remove agent from channel
  stop <nodeId|name>                                     Stop a node
  command <nodeName> <command> [--args k=v]... [--json-args '{...}'] [--from N]
                                                         Send a program-node command
  message <nodeId|name> <content> [--from N]             Send DM message to a node
  cancel <nodeId|name>                                   Cancel in-flight prompt
  capabilities                                           List adapter capabilities`;
}

export async function run(sub: string, args: string[]): Promise<void> {
  switch (sub) {
    case "list":
    case "ls": {
      let cwd: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--cwd" && args[i + 1]) { cwd = args[i + 1]; i++; }
      }
      const r = await post("/node/list", cwd ? { cwd } : {});
      emit(r, (x) => {
        if (!x.nodes?.length) return "(no nodes)";
        return x.nodes.map((n: any) =>
          `${n.id}\t${n.name}\t[${n.status}]\t${n.transport}\t${n.adapter || ""}`
        ).join("\n");
      });
      return;
    }
    case "spawn": {
      const adapter = args[0];
      if (!adapter) die("usage: nerve node spawn <adapter> [--name N] [--cwd D] [--model M]");
      let name: string | undefined, cwd: string | undefined, model: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--name" && args[i + 1]) { name = args[i + 1]; i++; }
        else if (args[i] === "--cwd" && args[i + 1]) { cwd = args[i + 1]; i++; }
        else if (args[i] === "--model" && args[i + 1]) { model = args[i + 1]; i++; }
      }
      const r = await post("/node/spawn", { adapter, name, cwd, model });
      checkErr(r, "node spawn");
      emit(r, (x) => `${x.nodeId}\t${x.name}\t[${x.status}]`);
      return;
    }
    case "join": {
      const nodeName = args[0];
      const channelId = args[1];
      if (!nodeName || !channelId) die("usage: nerve node join <nodeName> <channelId>");
      const r = await post("/node/join", { nodeName, channelId });
      checkErr(r, "node join");
      emit(r, () => "ok");
      return;
    }
    case "leave": {
      const nodeName = args[0];
      const channelId = args[1];
      if (!nodeName || !channelId) die("usage: nerve node leave <nodeName> <channelId>");
      const r = await post("/node/leave", { nodeName, channelId });
      checkErr(r, "node leave");
      emit(r, () => "ok");
      return;
    }
    case "stop": {
      const target = args[0];
      if (!target) die("usage: nerve node stop <nodeId|nodeName>");
      const r = await post("/node/stop", target.length === 12 ? { nodeId: target } : { nodeName: target });
      checkErr(r, "node stop");
      emit(r, () => "ok");
      return;
    }
    case "command": {
      const nodeName = args[0];
      const command = args[1];
      if (!nodeName || !command) die("usage: nerve node command <nodeName> <command> [--args k=v]... [--json-args '{...}'] [--from N]");
      const { rest, pairs } = parseArgPairs(args, 2);
      let from: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--from" && rest[i + 1]) { from = rest[i + 1]; i++; }
      }
      const r = await post("/node/command", { nodeName, command, args: pairs, from });
      checkErr(r, "node command");
      emit(r, (x) => JSON.stringify(x));
      return;
    }
    case "message": {
      const target = args[0];
      const contentParts: string[] = [];
      let from: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--from" && args[i + 1]) { from = args[i + 1]; i++; }
        else contentParts.push(args[i]);
      }
      const content = contentParts.join(" ");
      if (!target || !content) die("usage: nerve node message <nodeId|nodeName> <content> [--from N]");
      const body: Record<string, unknown> = { content, from };
      if (target.length === 12) body.nodeId = target;
      else body.nodeName = target;
      const r = await post("/node/message", body);
      checkErr(r, "node message");
      emit(r, () => "ok");
      return;
    }
    case "cancel": {
      const target = args[0];
      if (!target) die("usage: nerve node cancel <nodeId|nodeName>");
      const body: Record<string, unknown> = target.length === 12 ? { nodeId: target } : { nodeName: target };
      const r = await post("/node/cancel", body);
      checkErr(r, "node cancel");
      emit(r, (x) => JSON.stringify(x));
      return;
    }
    case "capabilities":
    case "caps": {
      const r = await post("/node/capabilities", {});
      checkErr(r, "node capabilities");
      emit(r, (x) => {
        const lines: string[] = [];
        for (const [adapter, cfg] of Object.entries(x.capabilities || {})) {
          const c = cfg as any;
          lines.push(`${adapter}${c.spawned ? " [running]" : ""}\t${c.description || ""}`);
          for (const cmd of Object.keys(c.commands || {})) {
            lines.push(`  ${cmd}`);
          }
        }
        return lines.join("\n");
      });
      return;
    }
    default:
      die(`unknown subcommand: nerve node ${sub}\n${help()}`);
  }
}
