/**
 * `nerve session <sub>` — codex/claude session management for spawned agents.
 *
 * Mirrors /session/* HTTP endpoints. Used to inspect & manipulate the agent's
 * conversation state (history, compaction, reset).
 */

import { post, emit, die, checkErr } from "../http.js";

export function help(): string {
  return `nerve session <sub> [args]

Subcommands:
  list <nodeName>                                List session ids for an agent
  load <nodeName> <sessionId>                    Reload a prior session
  clear <nodeName>                               Clear the current session
  compact <nodeName>                             Compact (summarize) the session
  reset <nodeName> --expected <id> --summary <path> [--self-reset] [--source S]
                                                 Reset session with summary handoff`;
}

export async function run(sub: string, args: string[]): Promise<void> {
  switch (sub) {
    case "list":
    case "ls": {
      const nodeName = args[0];
      if (!nodeName) die("usage: nerve session list <nodeName>");
      const r = await post("/session/list", { nodeName });
      checkErr(r, "session list");
      emit(r, (x) => JSON.stringify(x));
      return;
    }
    case "load": {
      const nodeName = args[0];
      const sessionId = args[1];
      if (!nodeName || !sessionId) die("usage: nerve session load <nodeName> <sessionId>");
      const r = await post("/session/load", { nodeName, sessionId });
      checkErr(r, "session load");
      emit(r, () => "ok");
      return;
    }
    case "clear": {
      const nodeName = args[0];
      if (!nodeName) die("usage: nerve session clear <nodeName>");
      const r = await post("/session/clear", { nodeName });
      checkErr(r, "session clear");
      emit(r, () => "ok");
      return;
    }
    case "compact": {
      const nodeName = args[0];
      if (!nodeName) die("usage: nerve session compact <nodeName>");
      const r = await post("/session/compact", { nodeName });
      checkErr(r, "session compact");
      emit(r, () => "ok");
      return;
    }
    case "reset": {
      const nodeName = args[0];
      if (!nodeName) die("usage: nerve session reset <nodeName> --expected <sessionId> --summary <path> [--self-reset] [--source S]");
      let expectedSessionId: string | undefined, summaryPath: string | undefined, source: string | undefined;
      let selfReset = false;
      for (let i = 1; i < args.length; i++) {
        if ((args[i] === "--expected" || args[i] === "--expected-session") && args[i + 1]) { expectedSessionId = args[i + 1]; i++; }
        else if (args[i] === "--summary" && args[i + 1]) { summaryPath = args[i + 1]; i++; }
        else if (args[i] === "--source" && args[i + 1]) { source = args[i + 1]; i++; }
        else if (args[i] === "--self-reset") { selfReset = true; }
      }
      if (!expectedSessionId || !summaryPath) die("session reset requires --expected and --summary");
      const r = await post("/session/reset", { nodeName, expectedSessionId, summaryPath, selfReset, source });
      checkErr(r, "session reset");
      emit(r, (x) => JSON.stringify(x));
      return;
    }
    default:
      die(`unknown subcommand: nerve session ${sub}\n${help()}`);
  }
}
