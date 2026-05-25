/**
 * restart-loop-detector — given per-service restart timestamps, decide
 * which services are in a restart loop (≥ threshold restarts within
 * a rolling window). Pure of I/O — fully deterministic given `now`.
 *
 * Used by system-watchdog evaluator to alert on supervised services
 * that keep crashing. The supervisor itself doesn't decide alerts;
 * it just exposes restart history and lets the watchdog evaluate.
 *
 * Window is a half-open interval (now - windowMs, now]: a restart at
 * exactly `now - windowMs` does NOT count (so an alert from 5min ago
 * naturally rolls off at the 5min mark, not 5min+1ms).
 */

export interface ServiceRestartSnapshot {
  name: string;
  restartHistory: number[];
}

export interface RestartLoopAlert {
  name: string;
  recentRestarts: number;
  windowMs: number;
}

export function detectRestartLoops(
  snapshots: ServiceRestartSnapshot[],
  windowMs: number,
  threshold: number,
  now: number,
): RestartLoopAlert[] {
  const alerts: RestartLoopAlert[] = [];
  const cutoff = now - windowMs;
  for (const s of snapshots) {
    const recent = s.restartHistory.filter(t => t > cutoff).length;
    if (recent >= threshold) {
      alerts.push({ name: s.name, recentRestarts: recent, windowMs });
    }
  }
  return alerts;
}
