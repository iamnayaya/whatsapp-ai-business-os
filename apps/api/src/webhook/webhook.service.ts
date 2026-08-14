import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '../../../../packages/db/src';
import type { AppLogger } from '../../../../packages/shared/src';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR,
  CONVERSATION_STATUS,
  EVENT_STATUS,
  EVENT_TYPE,
  MESSAGE_DIRECTION,
  MESSAGE_STATUS,
  isUniqueConstraintError,
  parseWebhookEnvelope,
  type WhatsAppChange,
  type WhatsAppChangeValue,
  type WhatsAppMessage,
  type WhatsAppStatus,
} from '../../../../packages/shared/src';
import type { Env } from '../../../../packages/shared/src';
import type { Queue } from 'bullmq';
import { enqueueInboundMessage, type InboundMessageJobData } from '../../../../packages/queue/src';
import type { AuditService } from '../../../../packages/audit/src';

export interface WebhookServiceDeps {
  prisma: PrismaClient;
  queue: Queue<InboundMessageJobData>;
  audit: AuditService;
  logger: AppLogger;
  config: Env;
}

const STATUS_MAP: Record<string, string> = {
  sent: MESSAGE_STATUS.SENT,
  delivered: MESSAGE_STATUS.DELIVERED,
  read: MESSAGE_STATUS.READ,
  failed: MESSAGE_STATUS.FAILED,
};

interface CapturedEvent {
  id: string;
  existing: boolean;
  status?: string;
}

@Injectable()
export class WebhookService {
  constructor(private readonly deps: WebhookServiceDeps) {}

  async handleWebhook(body: unknown): Promise<void> {
    const envelope = parseWebhookEnvelope(body);
    for (const entry of envelope.entry ?? []) {
      for (const change of entry.changes ?? []) {
        // 1. Persist the FULL raw change BEFORE any processing — nothing is lost.
        const event = await this.captureRawEvent(entry.id, change);
        if (event.existing && event.status === EVENT_STATUS.PROCESSED) {
          this.deps.logger.info('duplicate raw event skipped (already processed)', {
            eventId: event.id,
            eventKey: this.eventKeyOf(change),
          });
          continue;
        }

        let needsRetry = false;
        if (change.field === 'messages') {
          const value: WhatsAppChangeValue = change.value ?? {};
          for (const message of value.messages ?? []) {
            await this.processMessage(message, value);
          }
          for (const status of value.statuses ?? []) {
            const applied = await this.applyDeliveryStatus(status);
            if (!applied) needsRetry = true;
          }
        }

        // Non-message fields (e.g. account_update) are captured raw and marked
        // processed immediately — we just must not lose them.
        if (needsRetry) {
          this.deps.logger.debug('event left PENDING: a delivery status referenced a message not yet ingested');
        } else {
          await this.markEventProcessed(event.id);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Raw event capture (idempotency lock + lossless store)
  // ---------------------------------------------------------------------------

  private async captureRawEvent(entryId: string, change: WhatsAppChange): Promise<CapturedEvent> {
    const { eventKey, type } = this.deriveEventKey(entryId, change);
    const payload = (change.value ?? {}) as object;
    try {
      const created = await this.deps.prisma.incomingEvent.create({
        data: { eventKey, type, waAccountId: entryId, payload },
      });
      return { id: created.id, existing: false };
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const existing = await this.deps.prisma.incomingEvent.findUnique({ where: { eventKey } });
      if (!existing) throw err;
      return { id: existing.id, existing: true, status: existing.status };
    }
  }

  private deriveEventKey(entryId: string, change: WhatsAppChange): { eventKey: string; type: string } {
    const value = change.value ?? {};
    const messages = value.messages ?? [];
    const statuses = value.statuses ?? [];
    // Prefix by kind: WhatsApp status events reference the *same* id as the
    // message, so `msg:` / `status:` keep them distinct in the events table.
    if (messages.length > 0) return { eventKey: `msg:${messages[0].id}`, type: EVENT_TYPE.MESSAGE };
    if (statuses.length > 0) return { eventKey: `status:${statuses[0].id}`, type: EVENT_TYPE.STATUS };
    const hash = createHash('sha256').update(JSON.stringify(change)).digest('hex').slice(0, 16);
    return { eventKey: `change:${entryId}:${hash}`, type: `${EVENT_TYPE.CHANGE}:${change.field}` };
  }

  private eventKeyOf(change: WhatsAppChange): string {
    const value = change.value ?? {};
    const messages = value.messages ?? [];
    const statuses = value.statuses ?? [];
    return messages[0]?.id ? `msg:${messages[0].id}` : statuses[0]?.id ? `status:${statuses[0].id}` : 'raw-change';
  }

  private async markEventProcessed(eventId: string): Promise<void> {
    await this.deps.prisma.incomingEvent.update({
      where: { id: eventId },
      data: { status: EVENT_STATUS.PROCESSED, processedAt: new Date(), attempts: { increment: 1 } },
    });
  }

  // ---------------------------------------------------------------------------
  // Message processing
  // ---------------------------------------------------------------------------

  private async processMessage(message: WhatsAppMessage, value: WhatsAppChangeValue): Promise<void> {
    const metadata = value.metadata;
    const phoneNumberId = metadata?.phone_number_id ?? this.deps.config.WHATSAPP_PHONE_NUMBER_ID;
    const business = await this.getOrCreateBusiness(phoneNumberId, metadata?.display_phone_number);
    const contact = value.contacts?.[0];
    const customer = await this.getOrCreateCustomer(business.id, message.from, contact?.profile?.name);
    const conversation = await this.getOrCreateConversation(business.id, customer.id);

    let messageRow;
    try {
      messageRow = await this.deps.prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: MESSAGE_DIRECTION.INBOUND,
          waMessageId: message.id,
          type: message.type,
          text: this.extractText(message),
          mediaMimeType: this.extractMediaMimeType(message),
          status: MESSAGE_STATUS.RECEIVED,
          payload: { message, value } as object,
          sentAt: new Date(Number(message.timestamp) * 1000),
        },
      });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const found = await this.deps.prisma.message.findUnique({
        where: { waMessageId: message.id },
        include: { conversation: true },
      });
      if (found) {
        await this.enqueueMessage(found.id, found.conversationId, business.id, customer.id, message.from, message.id);
        this.deps.logger.info('duplicate message persisted; re-enqueued', { waMessageId: message.id });
      }
      return;
    }

    await this.deps.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: messageRow.sentAt },
    });

    await this.enqueueMessage(messageRow.id, conversation.id, business.id, customer.id, message.from, message.id);
    await this.deps.audit.record({
      businessId: business.id,
      actorType: AUDIT_ACTOR.WEBHOOK,
      action: AUDIT_ACTIONS.MESSAGE_INGESTED,
      entityType: 'MESSAGE',
      entityId: messageRow.id,
      details: { waMessageId: message.id, type: message.type },
    });
  }

  /**
   * Returns true when the status was applied to a known message, false when
   * the message is not ingested yet (delivery receipt raced ahead of the
   * message) — the raw event is left PENDING so a re-delivery can apply it.
   */
  private async applyDeliveryStatus(status: WhatsAppStatus): Promise<boolean> {
    const msg = await this.deps.prisma.message.findUnique({
      where: { waMessageId: status.id },
      include: { conversation: true },
    });
    if (!msg) return false;

    const mapped = STATUS_MAP[status.status];
    await this.deps.prisma.message.update({
      where: { id: msg.id },
      data: {
        status: mapped ?? msg.status,
        payload: { ...((msg.payload as object) ?? {}), statuses: status } as object,
      },
    });
    await this.deps.audit.record({
      businessId: msg.conversation.businessId,
      actorType: AUDIT_ACTOR.SYSTEM,
      action: AUDIT_ACTIONS.MESSAGE_STATUS_UPDATED,
      entityType: 'MESSAGE',
      entityId: msg.id,
      details: { waStatus: status.status },
    });
    return true;
  }

  private async enqueueMessage(
    messageId: string,
    conversationId: string,
    businessId: string,
    customerId: string,
    customerWaId: string,
    waMessageId: string,
  ): Promise<void> {
    await enqueueInboundMessage({
      queue: this.deps.queue,
      waMessageId,
      data: { messageId, conversationId, customerId, customerWaId, businessId },
    });
  }

  // ---------------------------------------------------------------------------
  // Entity upserts
  // ---------------------------------------------------------------------------

  private async getOrCreateBusiness(phoneNumberId: string, displayPhoneNumber?: string) {
    const phoneNumber = phoneNumberId || displayPhoneNumber || this.deps.config.BUSINESS_PHONE_NUMBER;
    if (!phoneNumber) {
      throw new Error('Cannot determine business phone number: webhook metadata and BUSINESS_PHONE_NUMBER are missing');
    }
    const existing = await this.deps.prisma.business.findUnique({ where: { phoneNumber } });
    if (existing) return existing;
    return this.deps.prisma.business.create({
      data: {
        name: this.deps.config.BUSINESS_NAME,
        phoneNumber,
        currency: this.deps.config.BUSINESS_CURRENCY,
        timezone: this.deps.config.BUSINESS_TIMEZONE,
      },
    });
  }

  private async getOrCreateCustomer(businessId: string, waId: string, profileName?: string) {
    const existing = await this.deps.prisma.customer.findUnique({
      where: { businessId_waId: { businessId, waId } },
    });
    if (existing) return existing;
    return this.deps.prisma.customer.create({
      data: { businessId, waId, profileName: profileName ?? null },
    });
  }

  private async getOrCreateConversation(businessId: string, customerId: string) {
    const existing = await this.deps.prisma.conversation.findFirst({
      where: { businessId, customerId, status: CONVERSATION_STATUS.OPEN },
      orderBy: { updatedAt: 'desc' },
    });
    if (existing) return existing;
    return this.deps.prisma.conversation.create({
      data: { businessId, customerId, status: CONVERSATION_STATUS.OPEN, channel: 'WHATSAPP' },
    });
  }

  // ---------------------------------------------------------------------------
  // Extraction helpers
  // ---------------------------------------------------------------------------

  private extractText(message: WhatsAppMessage): string | null {
    if (message.text?.body) return message.text.body;
    if (message.type === 'interactive') {
      const interactive = message.interactive;
      if (interactive?.button_reply?.title) return interactive.button_reply.title;
      if (interactive?.list_reply?.title) return interactive.list_reply.title;
      if (interactive?.button_reply?.id) return interactive.button_reply.id;
      if (interactive?.list_reply?.id) return interactive.list_reply.id;
    }
    return null;
  }

  private extractMediaMimeType(message: WhatsAppMessage): string | null {
    const media = [message.audio, message.image, message.video, message.document, message.sticker].find(Boolean);
    return media?.mime_type ?? null;
  }
}