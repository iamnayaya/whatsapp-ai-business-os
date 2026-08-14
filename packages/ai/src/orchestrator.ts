import type { PrismaClient } from '../../db/src';
import type { AppLogger } from '../../shared/src';
import type { AuditService } from '../../audit/src';
import type { PaystackLike } from '../../paystack/src';
import { AUDIT_ACTIONS, AUDIT_ACTOR, ESCALATION_CATEGORY, ESCALATION_STATUS } from '../../shared/src/constants';
import { Agent, SalesAgent, SupportAgent, LogisticsAgent } from './agent';
import type { AgentRunInput, AgentReply, AgentDeps } from './agent';
import { MessageRouter } from './router';
import type { AgentRoute, RouterLike } from './router';
import type { GeminiLike } from './types';

export interface AgentOrchestratorDeps {
  llm: GeminiLike;
  prisma: PrismaClient;
  audit: AuditService;
  logger: AppLogger;
  maxToolRounds?: number;
  fallbackReply?: string;
  /** Refund amount above which the support agent escalates to a human. */
  refundThreshold?: number;
  router?: RouterLike;
  /** Inject agents for tests; defaults to SalesAgent/SupportAgent/LogisticsAgent. */
  agents?: Record<AgentRoute, Pick<Agent, 'run'>>;
  /** Paystack client used by the create_payment_link tool (Phase 7). */
  paystack?: PaystackLike;
}

export interface OrchestratorReply extends AgentReply {
  routedTo: AgentRoute;
}

/**
 * Multi-agent orchestration (Phase 6). Routes each message to a specialized
 * agent (sales / support / logistics) while every agent shares ONE history and
 * the same tool registry, so the customer always sees a single assistant.
 */
export class AgentOrchestrator {
  readonly agents: Record<AgentRoute, Pick<Agent, 'run'>>;
  readonly router: RouterLike;

  constructor(private readonly deps: AgentOrchestratorDeps) {
    const { llm, prisma, audit, logger, maxToolRounds, fallbackReply, refundThreshold, paystack } = deps;
    const shared: AgentDeps = { llm, prisma, audit, logger, maxToolRounds, fallbackReply, refundThreshold, paystack };
    this.agents =
      deps.agents ??
      ({
        sales: new SalesAgent(shared),
        support: new SupportAgent(shared),
        logistics: new LogisticsAgent(shared),
      } as Record<AgentRoute, Pick<Agent, 'run'>>);
    this.router = deps.router ?? new MessageRouter({ llm });
  }

  async run(input: AgentRunInput): Promise<OrchestratorReply> {
    const text = routingText(input);
    const route = await this.router.route({ text, history: input.history });
    const reply = await this.agents[route].run(input);

    if (reply.escalated) {
      await this.recordEscalation(input, route, reply);
    }

    return { ...reply, routedTo: route };
  }

  private async recordEscalation(
    input: AgentRunInput,
    route: AgentRoute,
    reply: AgentReply,
  ): Promise<void> {
    const { prisma, audit } = this.deps;
    const category =
      normalizeEscalationCategory(reply.escalationCategory) ?? categorizeEscalation(reply.escalationReason ?? '');

    // Idempotent: keep at most one OPEN escalation per conversation, so a
    // BullMQ retry after a failed send does not create duplicate hand-offs.
    const existing = await prisma.escalation.findFirst({
      where: { conversationId: input.conversationId, status: ESCALATION_STATUS.OPEN },
    });
    if (existing) return;

    const created = await prisma.escalation.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        conversationId: input.conversationId,
        reason: reply.escalationReason ?? 'No reason provided',
        category,
        sourceAgent: route,
        status: ESCALATION_STATUS.OPEN,
      },
    });

    await audit.record({
      businessId: input.businessId,
      actorType: AUDIT_ACTOR.AI_AGENT,
      action: AUDIT_ACTIONS.ESCALATION_CREATED,
      entityType: 'ESCALATION',
      entityId: created.id,
      details: {
        conversationId: input.conversationId,
        category,
        sourceAgent: route,
        reason: reply.escalationReason ?? null,
      },
    });
  }
}

/** The text the router should classify: a clear voice transcription, else the last user turn. */
export function routingText(input: AgentRunInput): string {
  if (input.voiceNote?.clear && input.voiceNote.text.trim()) {
    return input.voiceNote.text.trim();
  }
  for (let i = input.history.length - 1; i >= 0; i--) {
    const turn = input.history[i];
    if (turn.role === 'user') {
      const text = (turn.text ?? turn.transcription ?? '').trim();
      if (text) return text;
    }
  }
  return '';
}

/** Fallback category when the agent did not pass one with escalate_to_human. */
export function categorizeEscalation(reason: string): string {
  const n = reason.toLowerCase();
  if (/angry|frustrat|disappoint|useless|stupid|awful|terrible|rude|annoyed|upset|furious|insult|not happy|yell/.test(n)) {
    return ESCALATION_CATEGORY.ANGRY_CUSTOMER;
  }
  if (/refund|money back|repay|reimburse/.test(n)) {
    return ESCALATION_CATEGORY.REFUND_REQUEST;
  }
  if (/not sure|unsure|not confident|cannot confirm|can't confirm|do not know|don't know|unknown|out of scope|unable to/.test(n)) {
    return ESCALATION_CATEGORY.AGENT_UNCERTAIN;
  }
  return ESCALATION_CATEGORY.OTHER;
}

const CATEGORY_ALIASES: Record<string, string> = {
  angry_customer: ESCALATION_CATEGORY.ANGRY_CUSTOMER,
  refund_request: ESCALATION_CATEGORY.REFUND_REQUEST,
  agent_uncertain: ESCALATION_CATEGORY.AGENT_UNCERTAIN,
  out_of_scope: ESCALATION_CATEGORY.OUT_OF_SCOPE,
};

/** Canonicalizes a category the model passed (e.g. "refund_request") to the constant form. */
export function normalizeEscalationCategory(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const key = value.trim().toLowerCase().replace(/[-\s]/g, '_');
  const alias = CATEGORY_ALIASES[key];
  if (alias) return alias;
  const upper = key.toUpperCase();
  return (Object.values(ESCALATION_CATEGORY) as string[]).includes(upper) ? upper : undefined;
}