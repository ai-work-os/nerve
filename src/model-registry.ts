/**
 * Model → context window size mapping.
 * ACP SDK reports 200K for all models; this provides actual values.
 */

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "opus": 200_000,
  "opus[1m]": 1_000_000,
  "sonnet": 200_000,
  "sonnet[1m]": 1_000_000,
  "haiku": 200_000,
  "mock-model-v1": 999_999,
};

/**
 * Get the actual context window size for a model.
 * Tries exact match first, then strips bracket suffix for base model match.
 * Returns undefined for unknown models (caller should fallback to ACP value).
 */
export function getContextWindow(model?: string): number | undefined {
  if (!model) return undefined;
  return MODEL_CONTEXT_WINDOWS[model]
    ?? MODEL_CONTEXT_WINDOWS[model.replace(/\[.*\]/, "")];
}
