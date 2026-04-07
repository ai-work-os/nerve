/**
 * Pure functions for nerve_node_list MCP tool.
 * Extracted for testability — no HTTP, no side effects.
 */

interface NodeLike {
  id: string;
  name: string;
  status: string;
  commands?: Record<string, { description: string; args?: Record<string, string> }>;
  events?: string[];
  channels: string[];
}

interface MappedNode {
  name: string;
  status: string;
  commands: Record<string, { description: string; args?: Record<string, string> }>;
  events: string[];
  channels: string[];
}

/**
 * Filter nodes by type and status.
 * - type "program" (default): nodes with non-empty commands
 * - type "agent": nodes without commands
 * - type "all": no type filter
 * - Stopped nodes excluded unless status explicitly set to "stopped"
 */
export function filterNodes(nodes: NodeLike[], type?: string, status?: string): NodeLike[] {
  const filterType = type || "program";
  let result = nodes;

  // Filter by type
  if (filterType === "program") {
    result = result.filter(n => n.commands && Object.keys(n.commands).length > 0);
  } else if (filterType === "agent") {
    result = result.filter(n => !n.commands || Object.keys(n.commands).length === 0);
  }

  // Filter by status
  if (status) {
    result = result.filter(n => n.status === status);
  } else {
    // Default: exclude stopped
    result = result.filter(n => n.status !== "stopped");
  }

  return result;
}

/**
 * Map nodes to output format: trim fields, channel ID→name, undefined→defaults.
 */
export function mapNodes(nodes: NodeLike[], channelMap: Map<string, string>): MappedNode[] {
  return nodes.map(n => ({
    name: n.name,
    status: n.status,
    commands: n.commands || {},
    events: n.events || [],
    channels: (n.channels || []).map(id => channelMap.get(id) || id),
  }));
}
