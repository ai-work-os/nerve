Code review findings for `~/.ai/nerve`

1. High: persisted channels are never reloaded after restart, so storage and runtime state diverge.
   Evidence:
   - `Store` persists channels and memberships with `insertChannel`, `listChannels`, and `getChannelNodes` in [src/store.ts](/Users/renjinxi/.ai/nerve/src/store.ts#L68) and [src/store.ts](/Users/renjinxi/.ai/nerve/src/store.ts#L120).
   - `Bus` startup only calls `markAllNodesStopped()` and initializes empty in-memory maps; it never restores channels from storage in [src/bus.ts](/Users/renjinxi/.ai/nerve/src/bus.ts#L23).
   Impact:
   - After a server restart, `channel.list` returns empty because it reads `this.channels`, while message history still exists in SQLite.
   - Any feature relying on durable channels is effectively broken despite the DB schema implying persistence.

2. High: HTTP endpoints trust caller-supplied `from`/`nodeName` without authentication or membership validation, enabling spoofed messages and unauthorized control.
   Evidence:
   - `/channel/post` only checks that `from` is present, then calls `postMessage(channelId, from, content)` in [src/server.ts](/Users/renjinxi/.ai/nerve/src/server.ts#L347).
   - `postMessage` does not verify that `from` belongs to the channel in [src/bus.ts](/Users/renjinxi/.ai/nerve/src/bus.ts#L155).
   - Management routes like `/node/stop`, `/channel/addNode`, and `/channel/removeNode` also accept arbitrary identifiers from the request body in [src/server.ts](/Users/renjinxi/.ai/nerve/src/server.ts#L330) and [src/server.ts](/Users/renjinxi/.ai/nerve/src/server.ts#L405).
   Impact:
   - Any local process that can reach the port can impersonate another node, inject channel messages, or stop/remove nodes.
   - This is an architectural trust-boundary flaw, not just missing polish.

3. Medium: process-node posting is nondeterministic once a node joins multiple channels.
   Evidence:
   - `postFromProcess` iterates `node.channels` and posts to the first entry, then breaks in [src/bus.ts](/Users/renjinxi/.ai/nerve/src/bus.ts#L191).
   Impact:
   - A process node cannot reliably know which channel its message will land in unless the caller passes `channelId` every time.
   - Because `Set` iteration follows join order, behavior depends on historical join sequence rather than explicit intent.

4. Medium: `nerve node stop` guesses whether the argument is an ID or a name by checking string length, which misroutes valid 12-character names.
   Evidence:
   - CLI sends `{ nodeId: target }` whenever `target.length === 12` in [src/cli.ts](/Users/renjinxi/.ai/nerve/src/cli.ts#L259).
   - Node IDs are 12-char NanoIDs today, but names are user-controlled and can also be 12 chars in [src/node-pool.ts](/Users/renjinxi/.ai/nerve/src/node-pool.ts#L46) and [src/node-pool.ts](/Users/renjinxi/.ai/nerve/src/node-pool.ts#L78).
   Impact:
   - `nerve node stop myreviewbot1` will try to stop a node ID that does not exist instead of the named node.
   - This is a user-facing bug with a straightforward fix: add explicit `--id` / `--name` flags or resolve by exact lookup server-side.

Validation:
- `./node_modules/.bin/tsc --noEmit` passed.
- `npm test` could not run in the sandbox because `tsx` failed to create its IPC pipe under `/var/folders/...` with `EPERM`, so runtime behavior was reviewed statically.
