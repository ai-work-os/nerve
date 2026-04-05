/**
 * Context Guardian — pure logic (no side effects).
 * Extracted so tests can import without triggering plugin startup.
 */

// --- Types ---

export interface ThresholdConfig {
  uniform?: number;
  large: number;
  small: number;
  boundary: number;
}

export interface NodeInfo {
  name: string;
  status: string;
  transport: string;
  usage?: { tokenUsed: number; tokenSize: number };
  sessionId?: string;
  channels: string[];
}

// --- Guardian logic ---

/** Select threshold based on model token size and config */
export function getThreshold(tokenSize: number, config: ThresholdConfig): number {
  if (config.uniform !== undefined) return config.uniform;
  return tokenSize >= config.boundary ? config.large : config.small;
}

/** Determine if an agent should be triggered for context handoff */
export function shouldTrigger(
  node: NodeInfo,
  threshold: number,
  triggeredSessions: Map<string, string>,
): boolean {
  if (!node.usage || node.transport !== "stdio") return false;
  if (node.status !== "idle") return false;
  if (node.usage.tokenSize === 0) return false;
  if (node.usage.tokenUsed / node.usage.tokenSize < threshold) return false;
  // Same session already triggered — don't repeat
  if (triggeredSessions.get(node.name) === node.sessionId) return false;
  return true;
}
