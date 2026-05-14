/**
 * `nerve remote <sub>` — spawn agents on remote peers.
 *
 * Mirrors /remote/spawn. Convenience wrapper to spawn on a registered peer.
 */

import { post, emit, die, checkErr } from "../http.js";

export function help(): string {
  return `nerve remote <sub> [args]

Subcommands:
  spawn <peer> <adapter> --name N --channel C [--cwd D] [--model M]
                                        Spawn an agent on a peer`;
}

export async function run(sub: string, args: string[]): Promise<void> {
  switch (sub) {
    case "spawn": {
      const peer = args[0];
      const adapter = args[1];
      if (!peer || !adapter) die("usage: nerve remote spawn <peer> <adapter> --name N --channel C [--cwd D] [--model M]");
      let name: string | undefined, channelId: string | undefined, cwd: string | undefined, model: string | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--name" && args[i + 1]) { name = args[i + 1]; i++; }
        else if (args[i] === "--channel" && args[i + 1]) { channelId = args[i + 1]; i++; }
        else if (args[i] === "--cwd" && args[i + 1]) { cwd = args[i + 1]; i++; }
        else if (args[i] === "--model" && args[i + 1]) { model = args[i + 1]; i++; }
      }
      if (!name || !channelId) die("nerve remote spawn requires --name and --channel");
      const r = await post("/remote/spawn", { peer, adapter, name, channelId, cwd, model });
      checkErr(r, "remote spawn");
      emit(r, (x) => x.name);
      return;
    }
    default:
      die(`unknown subcommand: nerve remote ${sub}\n${help()}`);
  }
}
