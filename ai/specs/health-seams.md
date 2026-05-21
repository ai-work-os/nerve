# Health-monitoring seams

How nerve detects unhealthy nodes today and how a future contributor extends
that. Two adapters live at two seams. This doc names them so the next health
feature has an obvious home.

> Related: [node-resilience.md](./node-resilience.md) — how Node identity
> survives WS disconnects. NodeResilience is about *recovery*; this doc is
> about *detection*.

## Two seams, not one

### Seam 1: OS-process supervision

**Owner:** `ServiceSupervisor` (`src/service/service-supervisor.ts`).

**Concern:** keep configured child processes alive. Spawn on start, restart
with exponential backoff on exit. The supervisor sees one signal — `exit` /
`error` events from `child_process` — and reacts immediately. It does not
know about ACP, nodes, channels, or even WebSockets.

**Inputs:** `~/.nerve/services.json` (or `NERVE_SERVICES_FILE`).

**Outputs:**
- spawned + restarted child processes
- in-memory `status(): ProcessStatus[]` snapshot (per-service state +
  `restartHistory` timestamps, capped at 10 entries)
- log lines (info/warn)

**Adapter shape:** OS-level. Reacts to process events in ~ms. Authoritative
on "is the binary still running."

**Where supervised plugins live:** the supervised process is usually itself a
nerve plugin (e.g. `mac-clipboard` on a Mac that talks to a remote home
nerve). The supervised process re-connects to nerve as a node via the WS
plugin layer. Supervisor and node identity are decoupled — supervisor sees
PIDs, nodepool sees registered nodes.

### Seam 2: Node-level health observation

**Owner:** `system-watchdog` plugin (`src/plugins/system-watchdog/`).

**Concern:** every 60 s, walk `node.list` and evaluate each node's
`health` contract. Emit alerts on liveness / idle / memory / restart-loop
breaches. The watchdog sees one signal — a polled `NodeInfo` snapshot — and
reacts on its scan tick. It does not know about supervisor internals or
child processes directly.

**Inputs:** `node.list` snapshot. Each `NodeInfo` carries an optional
`HealthContract` (declared by the plugin via `getHealth()`) and an optional
`supervised` field (today only set by the service-supervisor local node —
see below).

**Outputs:**
- appended alerts in `~/.ai/ops/state/system-alerts.md`
- channel message to `#ops`
- silence-window dedup (60 min per `nodeName:metric` key)

**Adapter shape:** ACP-node-level. Reacts on scan ticks (every 60 s). Sees
liveness, idle, memory — and now `supervised` for restart-loop detection.

## The bridge: service-supervisor as a local node

The two seams need a meeting point. Without one, you get noise:

| event | supervisor sees | watchdog sees |
|---|---|---|
| mac-clipboard process exits | `exit` → backoff → restart | next scan: node missing → liveness alert (false positive — supervisor is restarting it) |
| mac-clipboard keeps crashing | restart count ↑ ↑ ↑ | scan-by-scan idle/liveness alerts; never the **real** signal "restart loop" |

The bridge is a **local node** named `service-supervisor`, registered by
nerve itself when supervisor.start() succeeds. The node:

- Has `transport: "local"` (no WS, no stdio — an in-process module wearing a
  node face). See `NodePool.registerLocalNode`.
- Has a small `HealthContract`: `{ liveness: "connection", maxIdleMs:
  120_000 }`. Watchdog will alert if the local node stops getting touched —
  i.e. if the reporter tick stops, watchdog notices.
- Carries `supervised: SupervisedServiceStatus[]` — a snapshot of
  `supervisor.status()`. Updated by a 30 s tick in `cli.ts`.

Watchdog's `evaluateAll()` then has a new rule: for any node where
`supervised` exists, run `detectRestartLoops` and emit
`{ metric: "restart-loop", nodeName: <serviceName>, detail: "<N> restarts
in <X>s" }`.

**The supervisor still doesn't know about the watchdog.** All it does is
expose its state. The watchdog still doesn't know about child processes
directly. It reads `supervised` from `NodeInfo` like any other field.

## The data path

```
ServiceSupervisor (in-process)
  child.on("exit") → restart() → restartHistory.push(Date.now())
  state mutates in-memory
        │
        │ supervisor.status() — synchronous snapshot
        ▼
cli.ts tick (every 30s)
  reporterNode.supervised = supervisor.status()
  reporterNode.touch()
        │
        │ in-memory mutation on NerveNode
        ▼
NodePool.listAll() → toInfo() → /node/list (HTTP) / node.list (WS)
        │
        │ polled by watchdog (every 60s)
        ▼
evaluateAll(nodeInfo, now)
  → evaluateNode (health-contract rules)
  → evaluateSupervised → detectRestartLoops
        │
        ▼
Alert[] → silence dedup → ~/.ai/ops/state/system-alerts.md + #ops channel
```

## How to add a new health signal

| Concern | Where to add |
|---|---|
| "is this PID alive right now" | nowhere — watchdog already does it via `liveness: "process"` |
| "idle too long" | declare `maxIdleMs` in your plugin's `getHealth()` |
| "memory blowing up" | declare `maxMemoryMB` |
| "process is in a restart loop" | nowhere — supervisor + reporter + restart-loop-detector already covers it |
| "process is restarting fast but recovers between restarts" | extend `restart-loop-detector` (consider a sliding-rate signal) |
| "external service down" (e.g. tailscale, gitlab) | new plugin with `getHealth()` + custom check in the plugin; do NOT touch supervisor (it's local) |
| "supervisor itself crashed" | watchdog sees `service-supervisor` node idle (120s threshold) and alerts. If you want a faster signal, lower `maxIdleMs` or drive the touch from a more frequent tick |

## Non-goals

- **Cross-host supervision.** ServiceSupervisor is local. If a service runs
  on another host, that host runs its own nerve + supervisor; this seam does
  not federate.
- **Auto-recovery actions.** Watchdog reports; it does not kill / restart
  nodes (kill the running node and supervisor handles its restart). Adding
  "kill on memory breach" would be a separate seam (a remediation engine),
  not part of detection.
- **Hot-reconfigure of supervised services.** `~/.nerve/services.json` is
  read once at startup. Changing it requires restarting nerve. This is a
  deliberate non-goal — nerve isn't a service manager, just a supervisor.

## Defaults

| Setting | Default | Override |
|---|---|---|
| Watchdog scan interval | 60 s | `WATCHDOG_INTERVAL_MS` |
| Silence window | 60 min | `WATCHDOG_SILENCE_MS` |
| Reporter tick interval | 30 s | (no env, hardcoded — change cli.ts if needed) |
| Restart-loop window | 5 min | (pass `restartWindowMs` to `evaluateAll`) |
| Restart-loop threshold | 3 restarts | (pass `restartThreshold` to `evaluateAll`) |
| `restartHistory` cap | 10 entries | (`MAX_RESTART_HISTORY` in service-supervisor.ts) |
