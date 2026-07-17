/**
 * Token-cost estimation shared across layers (MCP rendering + the memory/code
 * briefing composer). Lives in core/ so both `mcp/` and `intelligence/` depend
 * downward on it rather than reaching sideways into each other.
 *
 * `chars/4` is a deliberately rough heuristic (real ratio ~3.2–3.5 for
 * code-dense text); see docs/OptimizationPlan.md T5 for calibration notes.
 */

export const CHARS_PER_TOKEN = 4;

/** Rough token count for a chunk of text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
