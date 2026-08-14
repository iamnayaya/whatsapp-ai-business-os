import type { GeminiLike } from './types';
import type { AgentTurn } from './agent';

export type AgentRoute = 'sales' | 'support' | 'logistics';

export interface RouteInput {
  text: string;
  /** Recent conversation turns — used only by the LLM fallback for context. */
  history?: AgentTurn[];
}

export interface RouterLike {
  route(input: RouteInput): Promise<AgentRoute> | AgentRoute;
}

const SUPPORT_TERMS = [
  'refund',
  'money back',
  'return',
  'returning',
  'exchange',
  'complain',
  'complaint',
  'wrong',
  'wrong item',
  'not what i ordered',
  'damaged',
  'broken',
  'defective',
  'faulty',
  'swollen',
  'expired',
  'spoilt',
  'spoiled',
  'bad product',
  'cancel my order',
  'cancellation',
  'issue with',
  'problem with',
  'worst',
  'angry',
  'frustrated',
  'disappointed',
  'not happy',
  'unhappy',
  'useless',
  'speak to a human',
  'talk to a human',
  'real human',
  'human being',
  'manager',
  'scam',
  'fraud',
  'rip off',
] as const;

const LOGISTICS_TERMS = [
  'delivery',
  'deliver',
  'dispatched',
  'dispatch',
  'shipping',
  'shipment',
  'courier',
  'where is my order',
  'my order status',
  'my order',
  'track',
  'tracking',
  'arrive',
  'arriving',
  'arrival',
  'when will it come',
  'when is it coming',
  'on the way',
  'is late',
  'not delivered',
  'delivery address',
  'change the address',
  'new address',
  'address',
  'pickup',
  'pick up',
  'eta',
  'transit',
  'package',
  'parcel',
  'fulfil',
  'fulfill',
] as const;

const SALES_TERMS = [
  'price',
  'how much',
  'cost',
  'buy',
  'sell',
  'sells',
  'order',
  'cart',
  'stock',
  'available',
  'do you have',
  'have you got',
  'product',
  'item',
  'quantity',
  'bag',
  'bag of',
  'crate',
  'crate of',
  'bottle of',
  'kilo',
  'kilogram',
  'catalog',
  'catalogue',
  'list',
  'what do you sell',
  'what is in your shop',
  'i want',
  'i would like',
  'i need',
] as const;

/** sales < logistics < support wins ties (a complaint beats a buying intent). */
const TIE_BREAK_ORDER: AgentRoute[] = ['support', 'logistics', 'sales'];

/**
 * Problem/delivery indicators are more diagnostic than generic buying words
 * ("i want", "order", "bag" appear in almost every thread), so support and
 * logistics matches weigh double against sales.
 */
const WEIGHTS: Record<AgentRoute, number> = { sales: 1, support: 2, logistics: 2 };

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countTerms(normalized: string, terms: readonly string[]): number {
  return terms.reduce((count, term) => count + (normalized.includes(term) ? 1 : 0), 0);
}

export function heuristicScore(text: string): Record<AgentRoute, number> {
  const normalized = normalize(text);
  return {
    sales: countTerms(normalized, SALES_TERMS) * WEIGHTS.sales,
    support: countTerms(normalized, SUPPORT_TERMS) * WEIGHTS.support,
    logistics: countTerms(normalized, LOGISTICS_TERMS) * WEIGHTS.logistics,
  };
}

/** Returns the best agent purely by keyword scoring, or null when nothing matches. */
export function classifyHeuristic(text: string): AgentRoute | null {
  const scores = heuristicScore(text);
  let best: AgentRoute | null = null;
  let bestScore = 0;
  for (const agent of TIE_BREAK_ORDER) {
    if (scores[agent] > bestScore) {
      best = agent;
      bestScore = scores[agent];
    }
  }
  return bestScore > 0 ? best : null;
}

function parseAgentRoute(text: string): AgentRoute | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { agent?: unknown };
    return parsed.agent === 'sales' || parsed.agent === 'support' || parsed.agent === 'logistics'
      ? parsed.agent
      : null;
  } catch {
    return null;
  }
}

/**
 * Deterministic keyword router with an LLM fallback for ambiguous messages
 * (nothing matched heuristically). The LLM fallback is optional — without an
 * `llm`, ambiguous messages default to the sales agent.
 */
export class MessageRouter implements RouterLike {
  constructor(private readonly opts: { llm?: GeminiLike } = {}) {}

  async route(input: RouteInput): Promise<AgentRoute> {
    const heuristic = classifyHeuristic(input.text);
    if (heuristic) return heuristic;

    if (this.opts.llm) {
      const llmRoute = await this.classifyWithLlm(input);
      if (llmRoute) return llmRoute;
    }
    return 'sales';
  }

  private async classifyWithLlm(input: RouteInput): Promise<AgentRoute | null> {
    const llm = this.opts.llm;
    if (!llm) return null;

    const context = (input.history ?? [])
      .slice(-4)
      .map((t) => `${t.role === 'user' ? 'Customer' : 'Assistant'}: ${t.text ?? t.transcription ?? ''}`)
      .join('\n');

    const contents = [
      {
        role: 'user' as const,
        parts: [{ text: `Conversation so far:\n${context}\n\nLatest customer message: ${input.text}` }],
      },
    ];

    const result = await llm.generate({
      contents,
      systemInstruction:
        'You route WhatsApp customer messages to the right assistant. Reply with ONLY JSON: {"agent":"sales"|"support"|"logistics"}. sales = products, prices, placing orders; support = complaints, returns, refunds, order issues; logistics = delivery, tracking, addresses. If in doubt, choose sales.',
      tools: [],
    });
    return parseAgentRoute(result.text ?? '');
  }
}