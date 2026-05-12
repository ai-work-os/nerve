/**
 * Command feedback — pure formatting functions for command responses.
 *
 * These functions convert command results into channel messages (strings).
 * The caller (dispatchCommand) decides whether to actually post them.
 */

export type CommandResult = {
  error?: string;
  reply?: string;
} | string | void;

export interface CommandDef {
  description: string;
  args?: Record<string, string>;
}

/**
 * Format onCommand return value into channel messages.
 * Returns 0~2 messages (error and/or reply).
 */
export function formatCommandResponse(result: CommandResult, from?: string): string[] {
  if (!from) return [];
  if (result === undefined || result === null) return [];

  if (typeof result === "string") {
    if (!result) return [];
    return [`@${from} [error] ${result}`];
  }

  const msgs: string[] = [];
  if (result.error) {
    msgs.push(`@${from} [error] ${result.error}`);
  }
  if (result.reply) {
    msgs.push(`@${from} ${result.reply}`);
  }
  return msgs;
}

/**
 * Format help text listing all commands.
 */
export function formatHelpText(commands: Record<string, CommandDef>, from?: string): string[] {
  if (!from) return [];

  const lines: string[] = [];
  for (const [name, def] of Object.entries(commands)) {
    const argStr = def.args ? " " + Object.keys(def.args).join(" ") : "";
    lines.push(`${name}${argStr} — ${def.description || ""}`);
  }
  lines.push("help — Show this help");
  return [`@${from} ${lines.join("\n")}`];
}

/**
 * Format unknown command error message.
 */
export function formatUnknownCommand(cmd: string, available: string[], from?: string): string[] {
  if (!from) return [];
  const avail = available.join(", ");
  return [`@${from} [error] unknown command: "${cmd}". available: ${avail}`];
}

/**
 * Format reportError message for async error reporting.
 */
export function formatReportError(to: string | undefined, message: string): string | undefined {
  if (!to) return undefined;
  return `@${to} [error] ${message}`;
}
