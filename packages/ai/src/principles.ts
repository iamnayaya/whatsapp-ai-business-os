/**
 * The sales agent's conversational-psychology self-tag: which principle (if
 * any) it applied this turn. Produced as a trailing marker on the reply, right
 * after the sentiment marker (see `buildAgentPrompt`), stripped before the
 * reply reaches WhatsApp, and persisted for later review in the dashboard.
 */
export const PRINCIPLE_LABELS = {
  tactical_empathy: 'TACTICAL_EMPATHY',
  social_proof: 'SOCIAL_PROOF',
  scarcity: 'SCARCITY',
  reciprocity: 'RECIPROCITY',
  authority: 'AUTHORITY',
  anchoring: 'ANCHORING',
  rapport: 'RAPPORT',
  none: 'NONE',
} as const;

export type AgentPrinciple = (typeof PRINCIPLE_LABELS)[keyof typeof PRINCIPLE_LABELS];

const PRINCIPLE_MARKER = /\[principle:\s*([a-z_]+)\s*\]/i;

/** Extracts a principle marker from agent text, or null when absent/unknown. */
export function parsePrinciple(text: string): AgentPrinciple | null {
  const match = PRINCIPLE_MARKER.exec(text);
  if (!match || !match[1]) return null;
  const label = PRINCIPLE_LABELS[match[1].toLowerCase() as keyof typeof PRINCIPLE_LABELS];
  return label ?? null;
}

/**
 * Splits agent text into the customer-facing reply (principle marker removed,
 * whitespace trimmed) and the applied principle (null when none was tagged).
 */
export function extractPrinciple(text: string): { text: string; principle: AgentPrinciple | null } {
  const principle = parsePrinciple(text);
  const clean = principle === null ? text : text.replace(PRINCIPLE_MARKER, '').replace(/[\s\n]+$/g, '');
  return { text: clean, principle };
}

/** Deterministic backstop when the model did not tag a principle. */
export function defaultPrinciple(): string {
  return PRINCIPLE_LABELS.none;
}
