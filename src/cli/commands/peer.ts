/**
 * `nerve peer <sub>` — peer-to-peer federation commands.
 *
 * Mirrors /peer/* HTTP endpoints. `health` is the only safe-from-anywhere
 * command; the remote-spawn/prompt/reply variants are used by nerve internally
 * (peer-to-peer routing) and are exposed mostly for debugging.
 */

import { post, emit, die, checkErr } from "../http.js";

export function help(): string {
  return `nerve peer <sub> [args]

Subcommands:
  health                                        Check peer reachability
  remote-spawn <adapter> --name N --origin-peer P --origin-channel C [--cwd D] [--model M]
                                                Spawn for a remote origin (internal)
  remote-prompt <remoteNode> <content> --channel C
                                                Forward prompt to remote (internal)
  remote-reply <fromPeer> <fromNode> <content> --origin-channel C
                                                Forward reply to origin (internal)`;
}

export async function run(sub: string, args: string[]): Promise<void> {
  switch (sub) {
    case "health": {
      const r = await post("/peer/health", {});
      checkErr(r, "peer health");
      emit(r, (x) => `ok\tport=${x.port}`);
      return;
    }
    case "remote-spawn": {
      const adapter = args[0];
      if (!adapter) die("usage: nerve peer remote-spawn <adapter> --name N --origin-peer P --origin-channel C [--cwd D] [--model M]");
      let name: string | undefined, originPeer: string | undefined, originChannelId: string | undefined,
          cwd: string | undefined, model: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--name" && args[i + 1]) { name = args[i + 1]; i++; }
        else if (args[i] === "--origin-peer" && args[i + 1]) { originPeer = args[i + 1]; i++; }
        else if (args[i] === "--origin-channel" && args[i + 1]) { originChannelId = args[i + 1]; i++; }
        else if (args[i] === "--cwd" && args[i + 1]) { cwd = args[i + 1]; i++; }
        else if (args[i] === "--model" && args[i + 1]) { model = args[i + 1]; i++; }
      }
      const r = await post("/peer/remote-spawn", { adapter, name, originPeer, originChannelId, cwd, model });
      checkErr(r, "peer remote-spawn");
      emit(r, (x) => `${x.nodeId}\t${x.name}\t${x.channelId}`);
      return;
    }
    case "remote-prompt": {
      const remoteNode = args[0];
      const content = args[1];
      let localChannelId: string | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--channel" && args[i + 1]) { localChannelId = args[i + 1]; i++; }
      }
      if (!remoteNode || !content || !localChannelId) die("usage: nerve peer remote-prompt <remoteNode> <content> --channel <localChannelId>");
      const r = await post("/peer/remote-prompt", { remoteNode, content, localChannelId });
      checkErr(r, "peer remote-prompt");
      emit(r, (x) => JSON.stringify(x));
      return;
    }
    case "remote-reply": {
      const fromPeer = args[0];
      const fromNode = args[1];
      const content = args[2];
      let originChannelId: string | undefined;
      for (let i = 3; i < args.length; i++) {
        if (args[i] === "--origin-channel" && args[i + 1]) { originChannelId = args[i + 1]; i++; }
      }
      if (!fromPeer || !fromNode || !content || !originChannelId) die("usage: nerve peer remote-reply <fromPeer> <fromNode> <content> --origin-channel <id>");
      const r = await post("/peer/remote-reply", { fromPeer, fromNode, content, originChannelId });
      checkErr(r, "peer remote-reply");
      emit(r, () => "ok");
      return;
    }
    default:
      die(`unknown subcommand: nerve peer ${sub}\n${help()}`);
  }
}
