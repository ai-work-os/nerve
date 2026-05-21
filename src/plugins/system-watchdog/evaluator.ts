/**
 * Watchdog evaluator — pure function: 给一个节点的 NodeInfo + 当前时间 + 探测器，
 * 返回该节点的 Alert 列表。无副作用，纯计算。
 */

import type { NodeInfo } from "../../transport/protocol.js";
import { detectRestartLoops } from "../../service/restart-loop-detector.js";

export interface Alert {
  nodeName: string;
  /** "restart-loop" reports on supervised services (nodeName is the
   *  service name, not the wrapping node name). See ai/specs/health-seams.md. */
  metric: "liveness" | "idle" | "memory" | "restart-loop";
  detail: string;
}

/** Default rolling window for restart-loop detection (5min). */
export const RESTART_LOOP_WINDOW_MS = 5 * 60 * 1000;
/** Default restart-count threshold within the window. */
export const RESTART_LOOP_THRESHOLD = 3;

/** 探测进程是否存活（pid 给定）。 */
export type ProcessChecker = (pid: number) => boolean;

/** 读进程 RSS（MB），失败返回 null。 */
export type MemoryReader = (pid: number) => number | null;

export function evaluateNode(
  node: NodeInfo,
  now: number,
  isProcessAlive: ProcessChecker,
  getMemoryMB: MemoryReader,
): Alert[] {
  const alerts: Alert[] = [];
  const c = node.health;
  if (!c) return alerts;

  // 1. liveness
  const liveness = c.liveness ?? "process";
  if (liveness === "process" && node.transport === "stdio" && node.pid) {
    if (!isProcessAlive(node.pid)) {
      alerts.push({
        nodeName: node.name,
        metric: "liveness",
        detail: `pid ${node.pid} not alive`,
      });
    }
  }

  // 2. maxIdleMs
  if (typeof c.maxIdleMs === "number") {
    const idleMs = now - node.lastActiveAt;
    if (idleMs > c.maxIdleMs) {
      const idleS = Math.round(idleMs / 1000);
      const maxS = Math.round(c.maxIdleMs / 1000);
      alerts.push({
        nodeName: node.name,
        metric: "idle",
        detail: `idle ${idleS}s > max ${maxS}s`,
      });
    }
  }

  // 3. maxMemoryMB
  if (c.maxMemoryMB && node.pid) {
    const memMB = getMemoryMB(node.pid);
    if (memMB !== null && memMB > c.maxMemoryMB) {
      alerts.push({
        nodeName: node.name,
        metric: "memory",
        detail: `${memMB}MB > ${c.maxMemoryMB}MB`,
      });
    }
  }

  return alerts;
}

/** Unified evaluation: health-contract rules + supervised-services rules.
 *  Watchdog scan calls this once per node and gets all alert types back. */
export function evaluateAll(
  node: NodeInfo,
  now: number,
  isProcessAlive: ProcessChecker,
  getMemoryMB: MemoryReader,
  options?: { restartWindowMs?: number; restartThreshold?: number },
): Alert[] {
  return [
    ...evaluateNode(node, now, isProcessAlive, getMemoryMB),
    ...evaluateSupervised(
      node, now,
      options?.restartWindowMs ?? RESTART_LOOP_WINDOW_MS,
      options?.restartThreshold ?? RESTART_LOOP_THRESHOLD,
    ),
  ];
}

/** Evaluate supervised services on a node (today: the service-supervisor
 *  local node carries .supervised). Reports per-service restart loops via
 *  the restart-loop-detector pure function. Independent of evaluateNode()
 *  because supervised services are NOT subject to the health-contract rules
 *  (no PID liveness here — supervisor is the authority on process exit). */
export function evaluateSupervised(
  node: NodeInfo,
  now: number,
  windowMs: number = RESTART_LOOP_WINDOW_MS,
  threshold: number = RESTART_LOOP_THRESHOLD,
): Alert[] {
  if (!node.supervised || node.supervised.length === 0) return [];
  const loops = detectRestartLoops(
    node.supervised.map(s => ({ name: s.name, restartHistory: s.restartHistory })),
    windowMs,
    threshold,
    now,
  );
  return loops.map(l => ({
    nodeName: l.name,
    metric: "restart-loop" as const,
    detail: `${l.recentRestarts} restarts in ${Math.round(l.windowMs / 1000)}s`,
  }));
}
