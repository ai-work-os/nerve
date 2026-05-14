/**
 * `nerve scene <sub>` — startup-scene management.
 *
 * Mirrors /scene/* HTTP endpoints.
 */

import { post, emit, die, checkErr } from "../http.js";

export function help(): string {
  return `nerve scene <sub> [args]

Subcommands:
  list                                List available scenes (alias: ls)
  start <name> [--cwd DIR]            Start a scene
  stop <name>                         Stop a running scene`;
}

export async function run(sub: string, args: string[]): Promise<void> {
  switch (sub) {
    case "list":
    case "ls": {
      const r = await post("/scene/list", {});
      emit(r, (x) => (x.scenes || []).map((s: any) =>
        `${s.name}${s.running ? "\t[running]" : ""}\t${s.file || ""}`
      ).join("\n"));
      return;
    }
    case "start": {
      const name = args[0];
      if (!name) die("usage: nerve scene start <name> [--cwd DIR]");
      let cwd: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--cwd" && args[i + 1]) { cwd = args[i + 1]; i++; }
      }
      const r = await post("/scene/start", { name, cwd });
      checkErr(r, "scene start");
      emit(r, (x) => {
        const lines = [`started: ${x.name}`];
        if (x.channelId) lines.push(`  channel: ${x.channelId}`);
        if (x.nodeIds?.length) lines.push(`  nodes: ${x.nodeIds.join(", ")}`);
        return lines.join("\n");
      });
      return;
    }
    case "stop": {
      const name = args[0];
      if (!name) die("usage: nerve scene stop <name>");
      const r = await post("/scene/stop", { name });
      checkErr(r, "scene stop");
      emit(r, () => "ok");
      return;
    }
    default:
      die(`unknown subcommand: nerve scene ${sub}\n${help()}`);
  }
}
