/**
 * `nerve dm <sub>` — direct messaging with a node.
 *
 * `read`  → /node/dm-history (added for CLI debug)
 * `send`  → /node/message
 *
 * Symmetrical to `nerve channel history|post` but for 1:1 conversation.
 */

import { post, emit, die, checkErr } from "../http.js";

export function help(): string {
  return `nerve dm <sub> [args]

Subcommands:
  read <nodeId|nodeName> [--limit N] [--before TS]   Read DM history
  send <nodeId|nodeName> <content> [--from N]        Send DM message`;
}

function bodyForTarget(target: string): Record<string, unknown> {
  return target.length === 12 ? { nodeId: target } : { nodeName: target };
}

export async function run(sub: string, args: string[]): Promise<void> {
  switch (sub) {
    case "read":
    case "history":
    case "hist": {
      const target = args[0];
      if (!target) die("usage: nerve dm read <nodeId|nodeName> [--limit N] [--before TS]");
      let limit = 50;
      let before: number | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1]); i++; }
        else if (args[i] === "--before" && args[i + 1]) { before = parseInt(args[i + 1]); i++; }
      }
      const body = { ...bodyForTarget(target), limit, before };
      const r = await post("/node/dm-history", body);
      checkErr(r, "dm read");
      emit(r, (x) => (x.messages || []).map((m: any) =>
        `[${new Date(m.ts).toISOString()}] ${m.role}/${m.sender}: ${m.text}`
      ).join("\n"));
      return;
    }
    case "send": {
      const target = args[0];
      const contentParts: string[] = [];
      let from: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--from" && args[i + 1]) { from = args[i + 1]; i++; }
        else contentParts.push(args[i]);
      }
      const content = contentParts.join(" ");
      if (!target || !content) die("usage: nerve dm send <nodeId|nodeName> <content> [--from N]");
      const body = { ...bodyForTarget(target), content, from };
      const r = await post("/node/message", body);
      checkErr(r, "dm send");
      emit(r, () => "ok");
      return;
    }
    default:
      die(`unknown subcommand: nerve dm ${sub}\n${help()}`);
  }
}
