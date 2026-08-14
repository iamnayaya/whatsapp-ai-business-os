import { MESSAGE_SENTIMENT } from '../../shared/src/constants';

export type MessageSentiment = (typeof MESSAGE_SENTIMENT)[keyof typeof MESSAGE_SENTIMENT];

const SENTIMENT_LABELS: Record<string, string> = {
  positive: MESSAGE_SENTIMENT.POSITIVE,
  neutral: MESSAGE_SENTIMENT.NEUTRAL,
  frustrated: MESSAGE_SENTIMENT.FRUSTRATED,
};

/**
 * The agent's own sentiment assessment, produced as a trailing marker on its
 * final reply (see `buildAgentPrompt`). This is NOT a separate analysis pass —
 * the model answers the customer AND tags its assessment in one generation.
 * The marker is stripped before the reply is sent to WhatsApp.
 */
const SENTIMENT_MARKER = /\[sentiment:\s*(positive|neutral|frustrated)\s*\]/i;

/** Extracts a sentiment marker from agent text, or null when absent. */
export function parseSentiment(text: string): string | null {
  const match = SENTIMENT_MARKER.exec(text);
  if (!match || !match[1]) return null;
  return SENTIMENT_LABELS[match[1].toLowerCase()] ?? null;
}

/**
 * Splits agent text into the customer-facing reply (marker removed, whitespace
 * trimmed) and the model's sentiment assessment (null when it did not tag one).
 */
export function extractSentiment(text: string): { text: string; sentiment: string | null } {
  const sentiment = parseSentiment(text);
  const clean = sentiment === null ? text : text.replace(SENTIMENT_MARKER, '').replace(/[\s\n]+$/g, '');
  return { text: clean, sentiment };
}

/**
 * Deterministic backstop when the model did not emit a marker: an angry
 * escalation is scored FRUSTRATED, everything else NEUTRAL.
 */
export function defaultSentiment(escalated: boolean, escalationCategory: string | undefined): string {
  if (escalated && escalationCategory === 'ANGRY_CUSTOMER') {
    return MESSAGE_SENTIMENT.FRUSTRATED;
  }
  return MESSAGE_SENTIMENT.NEUTRAL;
}