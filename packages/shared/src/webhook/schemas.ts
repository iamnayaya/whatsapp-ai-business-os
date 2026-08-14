import { z } from 'zod';

export const whatsappTextSchema = z.object({ body: z.string() }).passthrough();

export const whatsappMediaSchema = z
  .object({
    id: z.string(),
    mime_type: z.string().optional(),
    sha256: z.string().optional(),
    caption: z.string().optional(),
    filename: z.string().optional(),
  })
  .passthrough();

export const whatsappLocationSchema = z
  .object({
    latitude: z.number(),
    longitude: z.number(),
    name: z.string().optional(),
    address: z.string().optional(),
  })
  .passthrough();

export const whatsappButtonReplySchema = z
  .object({ id: z.string().optional(), title: z.string().optional() })
  .passthrough();

export const whatsappListReplySchema = z
  .object({ id: z.string().optional(), title: z.string().optional(), description: z.string().optional() })
  .passthrough();

export const whatsappInteractiveSchema = z
  .object({
    type: z.string().optional(),
    button_reply: whatsappButtonReplySchema.optional(),
    list_reply: whatsappListReplySchema.optional(),
  })
  .passthrough();

export const whatsappMessageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string(),
    type: z.string(),
    text: whatsappTextSchema.optional(),
    audio: whatsappMediaSchema.optional(),
    image: whatsappMediaSchema.optional(),
    video: whatsappMediaSchema.optional(),
    document: whatsappMediaSchema.optional(),
    sticker: whatsappMediaSchema.optional(),
    location: whatsappLocationSchema.optional(),
    interactive: whatsappInteractiveSchema.optional(),
    context: z.object({ from: z.string().optional(), id: z.string().optional() }).passthrough().optional(),
    errors: z.array(z.record(z.unknown())).optional(),
  })
  .passthrough();

export const whatsappStatusSchema = z
  .object({
    id: z.string(),
    status: z.enum(['sent', 'delivered', 'read', 'failed']),
    timestamp: z.string(),
    recipient_id: z.string().optional(),
    errors: z.array(z.record(z.unknown())).optional(),
  })
  .passthrough();

export const whatsappChangeValueSchema = z
  .object({
    messaging_product: z.string().optional(),
    metadata: z
      .object({
        display_phone_number: z.string().optional(),
        phone_number_id: z.string().optional(),
      })
      .passthrough()
      .optional(),
    contacts: z
      .array(z.object({ profile: z.object({ name: z.string().optional() }).optional(), wa_id: z.string() }).passthrough())
      .optional(),
    messages: z.array(whatsappMessageSchema).optional(),
    statuses: z.array(whatsappStatusSchema).optional(),
  })
  .passthrough();

export const whatsappChangeSchema = z
  .object({ field: z.string(), value: whatsappChangeValueSchema })
  .passthrough();

export const whatsappEntrySchema = z
  .object({ id: z.string(), changes: z.array(whatsappChangeSchema) })
  .passthrough();

export const whatsappEnvelopeSchema = z
  .object({ object: z.string(), entry: z.array(whatsappEntrySchema) })
  .passthrough();

export type WhatsAppEnvelope = z.infer<typeof whatsappEnvelopeSchema>;
export type WhatsAppEntry = z.infer<typeof whatsappEntrySchema>;
export type WhatsAppChange = z.infer<typeof whatsappChangeSchema>;
export type WhatsAppChangeValue = z.infer<typeof whatsappChangeValueSchema>;
export type WhatsAppMessage = z.infer<typeof whatsappMessageSchema>;
export type WhatsAppStatus = z.infer<typeof whatsappStatusSchema>;

export class InvalidWebhookPayloadError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(`Invalid WhatsApp webhook payload: ${issues.length} validation error(s)`);
    this.name = 'InvalidWebhookPayloadError';
  }
}

export function parseWebhookEnvelope(body: unknown): WhatsAppEnvelope {
  const parsed = whatsappEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidWebhookPayloadError(parsed.error.issues);
  }
  return parsed.data;
}
