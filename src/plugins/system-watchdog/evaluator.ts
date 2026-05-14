/**
 * Watchdog evaluator — pure function: 给一个节点的 NodeInfo + 当前时间 + 探测器，
 * 返回该节点的 Alert 列表。无副作用，纯计算。
 */

import type { NodeInfo } from "../../transport/protocol.js";

export interface Alert {
  nodeName: string;
  metric: "liveness" | "idle" | "memory";
  detail: string;
}

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
