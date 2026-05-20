# NodeResilience seam

A **Node** in nerve has two things that need protecting from network flakiness:
the physical WebSocket carrying its traffic, and the logical identity that the
rest of the system (channels, subscriptions, name uniqueness) is bound to.
Today those are protected by two layered mechanisms that, together, form what
we call the **NodeResilience seam**.

> One adapter = a hypothetical seam. Two = a real one. This doc names the seam
> so that future resilience features (reconnect backoff, session resume,
> message buffering across disconnect) have a known place to plug in instead
> of being scattered.

## Layer 1: transport health (WS heartbeat)

**Concern:** detect half-open WebSockets — one side thinks the link is alive
but the other has already gone away (NAT drop, sleeping laptop, ROM-killed
mobile observer). Without this, sends quietly black-hole.

**Mechanism:** both ends run a 30 s ping/pong loop. Each tick, mark "awaiting
pong" and send `ws.ping()`; on the next tick, if no pong (or any message) has
arrived, the connection is considered dead and `terminate()`d. This forces the
peer's `close` event to fire, which hands off to Layer 2.

**Code:**

- Server side: `src/server.ts` — `wsHeartbeat` interval + `wsAlive` WeakMap +
  `ws.on("pong")` handler. Env override: `NERVE_WS_HEARTBEAT_INTERVAL_MS`.
- Client side: `src/plugins/plugin-base.ts` — `_startHeartbeat()` /
  `_stopHeartbeat()` / `_heartbeatAlive`. Plugin option:
  `heartbeatIntervalMs` (default 30000).

**Adapter shape:** transport-layer health, agnostic to whether the node above
is transient or persistent. Anything sitting on a `WebSocket` benefits.

## Layer 2: identity survival (persistent node)

**Concern:** some nodes (e.g. `mac-clipboard` on a sleeping Mac, or any
mobile-side observer) should not vanish from channels every time the network
hiccups. Their logical identity — name, nodeId, channel membership — should
outlive the WS transport, flipping to `offline` while disconnected and
re-attaching the same nodeId on reconnect.

**Mechanism:** a `persistent: boolean` flag on the node. When set:

1. **disconnect** (driven by `ws.on("close")` in `server.ts`): instead of
   `nodePool.remove()`, the server calls `nodePool.markOffline(nodeId)`. Node
   stays in the pool, stays in every channel it joined, status flips to
   `"offline"`. Channel members still see it; @-mentions land in the channel
   (the node will see them on reconnect via channel-history replay).
2. **reconnect** (driven by `node.register` with `persistent: true`): the
   server calls `nodePool.findPersistentByName(name)` and, if found,
   `rebindWebSocket(nodeId, newWs)` — reuses the original nodeId, replays
   channel joins. Same identity, fresh transport.
3. **stale-close guard**: if a new register lands before the old socket's
   close event fires (register-before-close race), the close handler notices
   the node has already rebound to a newer socket and ignores itself — only
   drops the stale `wsNodeMap` entry.

**Code:**

- `src/node/node.ts` — `persistent` field.
- `src/node/node-pool.ts` — `registerWebSocket(..., persistent)`,
  `findPersistentByName`, `markOffline`, `rebindWebSocket`.
- `src/server.ts` — `ws.on("close")` branch on `node.persistent`;
  `node.register` handler rebinds when `persistent: true` + name found.
- `src/plugins/plugin-base.ts` — exposes `persistent?: boolean` plugin option;
  passes it through on register.

**Adapter shape:** identity-layer survival. Cares about Node, not about
WebSocket. Composes with Layer 1: heartbeat is what *detects* a dead transport
fast and triggers the close event that Layer 2 reacts to.

## How they compose

```
Plugin (client side)                  Server side
─────────────────────                 ───────────────
heartbeat ping/pong  ─── WS ───       heartbeat ping/pong
  → terminate() on miss                 → terminate() on miss
                                        → fires ws.on("close")
                                            ├── node.persistent ─► markOffline   (channels stay)
                                            └── transient        ─► remove        (channels lose)

plugin reconnect loop                  node.register
  (reconnectDelay)                      ├── persistent:true + name found
  → re-issue node.register              │     → rebindWebSocket  (same nodeId)
                                        └── otherwise
                                              → registerWebSocket  (new nodeId)
```

A persistent node that loses its laptop lid for an hour: heartbeat catches
the half-open WS within 30 s → marked offline → channels stay listing it →
when the laptop wakes, reconnect re-binds with the same nodeId → no membership
churn, no stale name conflict.

## Where future resilience features go

Anything that addresses "the network is unreliable but I want the node to
behave like it isn't" belongs at this seam:

- **Reconnect backoff** (today: fixed `reconnectDelay`, default 5 s). Should
  live in plugin-base or a shared client; do not invent per-plugin.
- **Buffering across disconnect** — channel-history replay (if a persistent
  node missed messages while offline) belongs here, not in individual nodes.
- **Session resume** — for ACP/agent nodes that want to recover their stream
  position across disconnect.

Do not bolt these onto individual plugins or scenes; widen the seam instead.

## Non-goals

- This seam is about **a single Node ↔ Server WS link**. Cross-server (e.g.
  federation, multi-nerve mesh) is out of scope and would be a different
  seam.
- This seam does not own channel-history replay semantics — it just provides
  the hooks Layer 2 needs (markOffline / rebind). Replay rules live in the
  channel manager.
