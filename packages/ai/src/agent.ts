import { Prisma, type PrismaClient } from '../../db/src';
import type { AppLogger } from '../../shared/src';
import type { AuditService } from '../../audit/src';
import type { PaystackLike } from '../../paystack/src';
import type { GeminiLike, GeminiTurn } from './types';
import { buildAgentPrompt, type AgentRole } from './prompt';
import { findTool, toGeminiDeclarations, type Cart, type ToolContext } from './tools';
import { languageName, type DetectedLanguage } from './transcription';
import { defaultSentiment, extractSentiment } from './sentiment';
import { defaultPrinciple, extractPrinciple } from './principles';

export interface AgentTurn {
  role: 'user' | 'model';
  text?: string;
  /** Verbatim transcription of a voice note, when the message was audio. */
  transcription?: string;
  type?: string;
}

export interface AgentRunInput {
  businessId: string;
  customerId: string;
  customerWaId: string;
  conversationId: string;
  history: AgentTurn[];
  currency: string;
  /**
   * Set when the current message was a voice note. `clear=false` means the
   * audio was inaudible/low-confidence — the agent must ask the customer to
   * repeat (in their language) instead of guessing what they said.
   */
  voiceNote?: {
    text: string;
    language: DetectedLanguage;
    confidence: number;
    clear: boolean;
  };
}

export interface AgentReply {
  text: string;
  escalated: boolean;
  escalationReason?: string;
  /** Category captured from the escalate_to_human tool (when the agent set one). */
  escalationCategory?: string;
  createdOrderId?: string;
  toolCalls: string[];
  /** Phase 8 — the agent's own assessment of the customer's tone for this
   * turn (POSITIVE | NEUTRAL | FRUSTRATED). Produced during the conversation
   * (a trailing marker on the reply), never a separate analysis pass. */
  sentiment: string;
  /** Which conversational-psychology principle (if any) the agent applied
   * this turn (e.g. TACTICAL_EMPATHY, ANCHORING, ... or NONE). Trailing marker,
   * logged for later review — see `principles.ts`. */
  principle: string;
}

export interface AgentDeps {
  llm: GeminiLike;
  prisma: PrismaClient;
  audit: AuditService;
  logger: AppLogger;
  maxToolRounds?: number;
  fallbackReply?: string;
  /** Refund amount above which the support agent escalates to a human. */
  refundThreshold?: number;
  /** Paystack client used by the create_payment_link tool (Phase 7). */
  paystack?: PaystackLike;
}

/** Phase 2 name kept for backward compatibility. */
export type SalesAgentDeps = AgentDeps;

const MAX_TOOL_ROUNDS = 6;
const FALLBACK_REPLY = 'Sorry, I ran into a problem responding. Please try again, or ask to speak with a human.';

export class Agent {
  constructor(
    protected readonly deps: AgentDeps,
    protected readonly role: AgentRole,
  ) {}

  async run(input: AgentRunInput): Promise<AgentReply> {
    const { businessId, customerId, customerWaId, conversationId, history, currency } = input;
    const { llm, prisma, logger } = this.deps;
    const maxToolRounds = this.deps.maxToolRounds ?? MAX_TOOL_ROUNDS;
    const loggerCtx = { businessId, customerId };

    const business = await prisma.business.findUnique({ where: { id: businessId } });
    const businessName = business?.name ?? 'the business';
    const businessCurrency = business?.currency ?? currency;

    // Load any persisted cart so it survives across messages.
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
    const existingMeta = (conversation?.metadata ?? {}) as { cart?: Cart } | null;
    const cart: Cart =
      existingMeta?.cart && Array.isArray(existingMeta.cart.items) ? existingMeta.cart : { items: [] };

    const tools = toGeminiDeclarations();
    const systemInstruction = buildAgentPrompt({
      businessName,
      currency: businessCurrency,
      role: this.role,
      refundThreshold: this.deps.refundThreshold,
    });
    const contents = buildContents(history);
    appendVoiceNoteDirective(contents, input.voiceNote);

    const ctx: ToolContext = {
      prisma,
      audit: this.deps.audit,
      businessId,
      customerId,
      customerWaId,
      conversationId,
      currency: businessCurrency,
      cart,
      cartDirty: false,
      paystack: this.deps.paystack,
    };

    const toolCalls: string[] = [];
    let escalated = false;
    let escalationReason: string | undefined;
    let escalationCategory: string | undefined;
    let createdOrderId: string | undefined;

    let finalText = '';
    for (let round = 0; round < maxToolRounds; round++) {
      const result = await llm.generate({ contents, systemInstruction, tools });

      if (!result.functionCalls || result.functionCalls.length === 0) {
        finalText = result.text.trim();
        break;
      }

      for (const call of result.functionCalls) {
        const tool = findTool(call.name);
        if (!tool) {
          contents.push({
            role: 'user',
            parts: [{ functionResponse: { name: call.name, response: { ok: false, error: `Unknown tool: ${call.name}` } } }],
          });
          continue;
        }
        toolCalls.push(call.name);
        const toolResult = await tool.handler(ctx, call.args ?? {});
        if (call.name === 'escalate_to_human') {
          escalated = true;
          escalationReason = (toolResult.data as { reason?: string } | undefined)?.reason ?? escalationReason;
          escalationCategory =
            (toolResult.data as { category?: string } | undefined)?.category ?? escalationCategory;
        }
        if (call.name === 'create_order' && toolResult.ok) {
          createdOrderId = (toolResult.data as { order?: { id?: string } }).order?.id;
        }
        if (!toolResult.ok) {
          logger.warn('agent tool failed', { ...loggerCtx, tool: call.name, error: toolResult.error });
        }
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name: call.name, response: { ...toolResult } } }],
        });
      }
    }

    if (!finalText) {
      if (escalated) {
        finalText = 'Sure — I am connecting you with a human representative who will take over shortly.';
      } else {
        finalText = this.deps.fallbackReply ?? FALLBACK_REPLY;
      }
    }

    // The model tags its sentiment + principle assessment on the end of the
    // reply; strip the markers before sending, and fall back to deterministic
    // values when the model did not comply (angry escalation -> FRUSTRATED,
    // else NEUTRAL / NONE).
    const { text: replyText, sentiment: parsedSentiment } = extractSentiment(finalText);
    const sentiment = parsedSentiment ?? defaultSentiment(escalated, escalationCategory);
    const { text: replyTextWithoutPrinciple, principle: parsedPrinciple } = extractPrinciple(replyText);
    const principle = parsedPrinciple ?? defaultPrinciple();

    // Persist the cart if any tool modified it, so the next message resumes it.
    if (ctx.cartDirty && conversation) {
      const meta: Record<string, unknown> = { ...(existingMeta ?? {}) };
      meta.cart = ctx.cart;
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { metadata: meta as unknown as Prisma.InputJsonValue },
      });
    }

    return {
      text: replyTextWithoutPrinciple,
      escalated,
      escalationReason,
      escalationCategory,
      createdOrderId,
      toolCalls,
      sentiment,
      principle,
    };
  }
}

export class SalesAgent extends Agent {
  constructor(deps: AgentDeps) {
    super(deps, 'sales');
  }
}

export class SupportAgent extends Agent {
  constructor(deps: AgentDeps) {
    super(deps, 'support');
  }
}

export class LogisticsAgent extends Agent {
  constructor(deps: AgentDeps) {
    super(deps, 'logistics');
  }
}

/**
 * Maps DB message history to Gemini turns: role INBOUND->user, OUTBOUND->model.
 * Media-only messages become a short placeholder so the model still sees a
 * voice note arrived. Consecutive same-role turns are merged, and leading
 * model turns dropped (contents must end on a user turn).
 */
export function buildContents(history: AgentTurn[]): GeminiTurn[] {
  const contents: GeminiTurn[] = [];
  const roleOf = (t: AgentTurn): 'user' | 'model' => (t.role === 'user' ? 'user' : 'model');

  for (const turn of history) {
    const role = roleOf(turn);
    const text = turn.text?.trim() || turn.transcription?.trim() || placeholderFor(turn.type);
    if (!text) continue;

    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text });
      continue;
    }
    if (contents.length === 0 && role === 'model') continue;
    contents.push({ role, parts: [{ text }] });
  }

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
  }
  return contents;
}

function placeholderFor(type?: string): string {
  if (!type) return '';
  if (type === 'audio') return '[Voice note]';
  if (type === 'image') return '[Image]';
  if (type === 'video') return '[Video]';
  if (type === 'document') return '[Document]';
  return '';
}

/**
 * When the incoming message was a CLEAR voice note, its transcription already
 * flowed in as the user turn (the handler stores it as `transcription`, which
 * `buildContents` maps to text). When it was UNCLEAR, inject a system-level
 * directive so the model asks the customer to repeat in their own language —
 * it must never guess what an inaudible voice note said.
 */
export function appendVoiceNoteDirective(contents: GeminiTurn[], voiceNote?: AgentRunInput['voiceNote']): void {
  if (!voiceNote || voiceNote.clear) return;
  const lang = languageName(voiceNote.language);
  const directive =
    `[Voice note could not be understood (detected language: ${lang}). ` +
    `Do NOT guess what the customer said. Politely ask them to repeat their message, ` +
    `speaking clearly or typing it — reply in ${lang}.]`;
  const last = contents[contents.length - 1];
  if (last && last.role === 'user') {
    last.parts.push({ text: directive });
  } else {
    contents.push({ role: 'user', parts: [{ text: directive }] });
  }
}

export { placeholderFor, languageName };