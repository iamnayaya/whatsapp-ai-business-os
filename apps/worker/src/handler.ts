import type { PrismaClient } from '../../../packages/db/src';
import type { AppLogger } from '../../../packages/shared/src';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR,
  CONVERSATION_STATUS,
  MESSAGE_DIRECTION,
  MESSAGE_STATUS,
  messageFromError,
} from '../../../packages/shared/src';
import type { InboundMessageJob } from '../../../packages/queue/src';
import type { AuditService } from '../../../packages/audit/src';
import type { WhatsAppClient } from '../../../packages/whatsapp/src';
import type { AgentOrchestrator, Transcriber, TranscriptionResult } from '../../../packages/ai/src';
import { KILL_SWITCH_REPLY_TEXT } from '../../../packages/ops/src';

export interface InboundMessageHandlerDeps {
  prisma: PrismaClient;
  audit: AuditService;
  logger: AppLogger;
  whatsapp: WhatsAppClient;
  agent: AgentOrchestrator;
  transcriber: Transcriber;
  /** Only `isActive` is needed here; the full control surface lives in the API. */
  killSwitch: { isActive(): Promise<boolean> };
}

/** Cost guard: never transcribe (and pay for) voice notes longer than this. */
const MAX_AUDIO_DURATION_SECONDS = 180;

/**
 * Ingests a received message, then runs the AI Sales Agent on inbound text to
 * produce a reply. The BullMQ retry/backoff contract stays unchanged: any
 * failure marks the message FAILED, audits, and rethrows for retry.
 */
export async function handleInboundMessage(job: InboundMessageJob, deps: InboundMessageHandlerDeps): Promise<void> {
  const { messageId, businessId } = job.data;
  const logger = deps.logger.child(`job:${job.id}`);

  try {
    await deps.prisma.message.update({
      where: { id: messageId },
      data: { status: MESSAGE_STATUS.PROCESSING },
    });

    await deps.audit.record({
      businessId,
      actorType: AUDIT_ACTOR.SYSTEM,
      action: AUDIT_ACTIONS.MESSAGE_INGESTED,
      entityType: 'MESSAGE',
      entityId: messageId,
      details: { jobId: job.id, attempts: job.attemptsMade + 1 },
    });

    await runAgentIfText(job, deps, logger);

    await deps.prisma.message.update({
      where: { id: messageId },
      data: { status: MESSAGE_STATUS.PROCESSED },
    });
    logger.info('message processed', { messageId });
  } catch (err) {
    await deps.prisma.message
      .update({ where: { id: messageId }, data: { status: MESSAGE_STATUS.FAILED } })
      .catch(() => undefined);
    await deps.audit.record({
      businessId,
      actorType: AUDIT_ACTOR.SYSTEM,
      action: AUDIT_ACTIONS.MESSAGE_INGEST_FAILED,
      entityType: 'MESSAGE',
      entityId: messageId,
      details: { jobId: job.id, error: messageFromError(err) },
    });
    logger.error('message processing failed', { messageId, error: messageFromError(err) });
    throw err;
  }
}

async function runAgentIfText(
  job: InboundMessageJob,
  deps: InboundMessageHandlerDeps,
  logger: AppLogger,
): Promise<void> {
  const { messageId, conversationId, customerId, customerWaId, businessId } = job.data;

  // Kill switch (Phase 9): when active, the AI agent is paused. Every customer
  // message gets a static fallback reply while webhooks, payments, and
  // follow-ups keep running. Checked BEFORE transcription so Gemini is never
  // billed while paused.
  if (await deps.killSwitch.isActive()) {
    await sendCannedReply({
      deps,
      conversationId,
      customerWaId,
      text: KILL_SWITCH_REPLY_TEXT,
      logger,
      context: { messageId, killSwitch: true },
    });
    return;
  }

  const message = await deps.prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: { include: { business: true } } },
  });
  if (!message) return;

  // Use the business's configured currency, never a hardcoded literal.
  const currency = message.conversation.business.currency;

  let voiceNote: { text: string; language: TranscriptionResult['language']; confidence: number; clear: boolean } | undefined;

  // Text (and interactive button/list replies, whose answer is stored in
  // `text`) goes straight to the agent. Audio is transcribed first — Phase 3 —
  // then the transcription is fed to the SAME agent pipeline as text.
  if (!message.text && message.type === 'audio') {
    const audioDuration = (message.payload as { message?: { audio?: { duration?: number } } } | null)?.message?.audio?.duration;
    // Cost guard: a long voice note is billed at input-token rates with no
    // upper bound. Above the cap we politely ask for a shorter note instead
    // of paying for a huge audio transcription.
    if (typeof audioDuration === 'number' && audioDuration > MAX_AUDIO_DURATION_SECONDS) {
      await sendCannedReply({
        deps,
        conversationId,
        customerWaId,
        text: 'That voice note is quite long — could you send a shorter one (under 3 minutes), or type your request? Thanks!',
        logger,
        context: { messageId, audioDuration },
      });
      return;
    }
    const transcribed = await transcribeVoiceNote(message, businessId, deps, logger);
    if (transcribed) {
      voiceNote = {
        text: transcribed.text,
        language: transcribed.language,
        confidence: transcribed.confidence,
        clear: transcribed.clear,
      };
    }
  }
  if (!message.text && !voiceNote) return; // other media-only messages are not answered yet

  const history = await loadHistory(deps.prisma, conversationId);
  logger.debug('agent context loaded', {
    messageId,
    conversationId,
    historyTurns: history.length,
    lastTurn: history[history.length - 1] ?? null,
    historyText: history.map((t) => `${t.role}: ${t.text ?? t.transcription ?? ''}`).join('\n'),
  });
  const agentReply = await deps.agent.run({
    businessId,
    customerId,
    customerWaId,
    conversationId,
    history,
    currency,
    voiceNote,
  });
  if (!agentReply.text.trim()) return;

  if (agentReply.escalated) {
    await deps.prisma.conversation.update({
      where: { id: conversationId },
      data: { status: CONVERSATION_STATUS.ESCALATED },
    });
    await deps.audit.record({
      businessId,
      actorType: AUDIT_ACTOR.AI_AGENT,
      action: AUDIT_ACTIONS.ESCALATED_TO_HUMAN,
      entityType: 'CONVERSATION',
      entityId: conversationId,
      details: {
        reason: agentReply.escalationReason,
        category: agentReply.escalationCategory,
        routedTo: agentReply.routedTo,
        messageId,
      },
    });
    logger.info('conversation escalated to human', {
      conversationId,
      reason: agentReply.escalationReason,
      routedTo: agentReply.routedTo,
    });
  }

  const sent = await deps.whatsapp.sendText(customerWaId, agentReply.text);
  const outbound = await deps.prisma.message.create({
    data: {
      conversationId,
      direction: MESSAGE_DIRECTION.OUTBOUND,
      waMessageId: sent.waMessageId ?? null,
      type: 'text',
      text: agentReply.text,
      status: MESSAGE_STATUS.SENT,
      payload: {
        ...(agentReply.createdOrderId ? { orderId: agentReply.createdOrderId } : {}),
        routedTo: agentReply.routedTo,
        toolCalls: agentReply.toolCalls,
        sentiment: agentReply.sentiment,
        principle: agentReply.principle,
      },
      sentiment: agentReply.sentiment,
      sentAt: new Date(),
    },
  });
  await deps.prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: outbound.sentAt },
  });
  await deps.audit.record({
    businessId,
    actorType: AUDIT_ACTOR.AI_AGENT,
    action: AUDIT_ACTIONS.MESSAGE_SENT,
    entityType: 'MESSAGE',
    entityId: outbound.id,
    details: {
      waMessageId: sent.waMessageId,
      routedTo: agentReply.routedTo,
      tools: agentReply.toolCalls,
      principle: agentReply.principle,
    },
  });
  logger.info('agent reply sent', {
    messageId,
    tools: agentReply.toolCalls,
    escalated: agentReply.escalated,
    routedTo: agentReply.routedTo,
    principle: agentReply.principle,
  });
}

/** Sends a short non-agent reply (e.g. the voice-note length guard) and persists it. */
async function sendCannedReply(args: {
  deps: InboundMessageHandlerDeps;
  conversationId: string;
  customerWaId: string;
  text: string;
  logger: AppLogger;
  context: Record<string, unknown>;
}): Promise<void> {
  const { deps, conversationId, customerWaId, text, logger, context } = args;
  await deps.whatsapp.sendText(customerWaId, text);
  await deps.prisma.message.create({
    data: {
      conversationId,
      direction: MESSAGE_DIRECTION.OUTBOUND,
      waMessageId: null,
      type: 'text',
      text,
      status: MESSAGE_STATUS.SENT,
      sentAt: new Date(),
    },
  });
  await deps.prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
  logger.info('canned reply sent', context);
}

/**
 * Phase 3 voice notes: download the audio via WhatsApp's media API, transcribe
 * it, and persist the transcription + detected language + confidence on the
 * message row (alongside the original media reference) for audit. Returns null
 * when there is no downloadable audio so the caller skips the agent.
 */
async function transcribeVoiceNote(
  message: { id: string; payload: unknown; mediaMimeType: string | null },
  businessId: string,
  deps: InboundMessageHandlerDeps,
  logger: AppLogger,
): Promise<TranscriptionResult | null> {
  const raw = message.payload as { message?: { audio?: { id?: string } } } | null;
  const mediaId = raw?.message?.audio?.id;
  if (!mediaId) return null;

  const downloaded = await deps.whatsapp.downloadMedia(mediaId);
  const result = await deps.transcriber.transcribe({ buffer: downloaded.buffer, mimeType: downloaded.mimeType });

  // Persist transcription alongside the audio reference for later review.
  await deps.prisma.message.update({
    where: { id: message.id },
    data: {
      transcription: result.text,
      mediaUrl: mediaId,
      mediaMimeType: downloaded.mimeType,
      payload: {
        ...((raw as object) ?? {}),
        transcription: {
          text: result.text,
          language: result.language,
          confidence: result.confidence,
          clear: result.clear,
          mimeType: downloaded.mimeType,
        },
      },
    },
  });

  await deps.audit.record({
    businessId,
    actorType: AUDIT_ACTOR.AI_AGENT,
    action: AUDIT_ACTIONS.VOICE_NOTE_TRANSCRIBED,
    entityType: 'MESSAGE',
    entityId: message.id,
    details: {
      mediaId,
      language: result.language,
      confidence: result.confidence,
      clear: result.clear,
      text: result.text,
    },
  });
  logger.info('voice note transcribed', { messageId: message.id, language: result.language, confidence: result.confidence, clear: result.clear });
  return result;
}

export async function loadHistory(prisma: PrismaClient, conversationId: string) {
  // Load the full conversation history (up to a generous limit) so the agent
  // never loses context mid-conversation. The previous limit of 10 caused
  // the agent to forget earlier turns and repeat generic questions.
  // 100 messages covers virtually all WhatsApp conversations while staying
  // well within the model's context window.
  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
    take: 100,
  });
  return messages.reverse().map((m) => ({
    role: m.direction === MESSAGE_DIRECTION.INBOUND ? ('user' as const) : ('model' as const),
    text: m.text ?? undefined,
    transcription: m.transcription ?? undefined,
    type: m.type,
  }));
}