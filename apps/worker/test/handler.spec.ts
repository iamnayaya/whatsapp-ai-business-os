import { describe, expect, it, vi } from 'vitest';
import { handleInboundMessage } from '../src/handler';
import type { InboundMessageJob } from '../../../packages/queue/src';
import type { AuditService } from '../../../packages/audit/src';
import type { WhatsAppClient } from '../../../packages/whatsapp/src';
import { createLogger, MESSAGE_DIRECTION, MESSAGE_STATUS } from '../../../packages/shared/src';

const silentLogger = createLogger('test', { destination: () => undefined });

const businessCtx = { conversation: { business: { currency: 'NGN' } } };

function makeJob(overrides: Partial<InboundMessageJob> = {}): InboundMessageJob {
  return {
    id: 'job-1',
    data: { messageId: 'msg-1', conversationId: 'conv-1', customerId: 'cust-1', customerWaId: '2348012345678', businessId: 'biz-1' },
    attemptsMade: 0,
    ...overrides,
  } as InboundMessageJob;
}

function makePrisma() {
  const message = {
    update: vi.fn().mockResolvedValue({}),
    findUnique: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
  };
  const conversation = { update: vi.fn().mockResolvedValue({}) };
  return { message, conversation };
}

function makeDeps(prisma: ReturnType<typeof makePrisma>) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const whatsapp = {
    sendText: vi.fn().mockResolvedValue({ waMessageId: 'wamid.out.1' }),
    downloadMedia: vi.fn().mockResolvedValue({ buffer: Buffer.from('fake-audio-bytes'), mimeType: 'audio/ogg; codecs=opus' }),
  } as unknown as WhatsAppClient;
  const agent = { run: vi.fn() };
  const transcriber = {
    transcribe: vi.fn().mockResolvedValue({ text: 'ina bukatar rice', language: 'ha', confidence: 0.9, clear: true }),
  };
  const killSwitch = { isActive: vi.fn().mockResolvedValue(false) };
  return {
    prisma: prisma as never,
    audit,
    logger: silentLogger,
    whatsapp,
    agent: agent as never,
    agentRun: agent.run,
    transcriber: transcriber as never,
    transcribe: transcriber.transcribe,
    killSwitch,
  };
}

describe('handleInboundMessage', () => {
  it('marks PROCESSED and audits for a media-only message (agent skipped)', async () => {
    const prisma = makePrisma();
    prisma.message.findUnique.mockResolvedValueOnce({ id: 'msg-1', text: null, ...businessCtx });
    const deps = makeDeps(prisma);

    await handleInboundMessage(makeJob(), deps as never);

    expect(prisma.message.update).toHaveBeenNthCalledWith(1, { where: { id: 'msg-1' }, data: { status: MESSAGE_STATUS.PROCESSING } });
    expect(prisma.message.update).toHaveBeenNthCalledWith(2, { where: { id: 'msg-1' }, data: { status: MESSAGE_STATUS.PROCESSED } });
    expect(deps.agentRun).not.toHaveBeenCalled();
  });

  it('runs the agent on text, sends the reply, stores it OUTBOUND, and audits MESSAGE_SENT', async () => {
    const prisma = makePrisma();
    prisma.message.findUnique.mockResolvedValueOnce({ id: 'msg-1', text: 'Price?', ...businessCtx });
    prisma.message.create.mockResolvedValueOnce({ id: 'out-1', sentAt: new Date('2026-01-01T00:00:00Z') });
    const deps = makeDeps(prisma);
    deps.agentRun.mockResolvedValueOnce({ text: 'Rice 50kg is ₦85,000.', escalated: false, toolCalls: ['search_products'], sentiment: 'NEUTRAL' });

    await handleInboundMessage(makeJob(), deps as never);

    expect(deps.agentRun).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: 'biz-1', customerId: 'cust-1', customerWaId: '2348012345678', conversationId: 'conv-1' }),
    );
    expect(deps.whatsapp.sendText).toHaveBeenCalledWith('2348012345678', 'Rice 50kg is ₦85,000.');
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          direction: MESSAGE_DIRECTION.OUTBOUND,
          type: 'text',
          text: 'Rice 50kg is ₦85,000.',
          status: MESSAGE_STATUS.SENT,
          waMessageId: 'wamid.out.1',
          sentiment: 'NEUTRAL',
        }),
      }),
    );
    expect(deps.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MESSAGE_SENT', entityType: 'MESSAGE' }),
    );
    expect(prisma.message.update).toHaveBeenNthCalledWith(2, { where: { id: 'msg-1' }, data: { status: MESSAGE_STATUS.PROCESSED } });
  });

  it('escalates the conversation and sends a handoff when the agent escalates', async () => {
    const prisma = makePrisma();
    prisma.message.findUnique.mockResolvedValueOnce({ id: 'msg-1', text: 'I want a human', ...businessCtx });
    prisma.message.create.mockResolvedValueOnce({ id: 'out-2', sentAt: new Date('2026-01-01T00:00:00Z') });
    const deps = makeDeps(prisma);
    deps.agentRun.mockResolvedValueOnce({
      text: 'Connecting you with a human representative.',
      escalated: true,
      escalationReason: 'customer asked for a human',
      toolCalls: ['escalate_to_human'],
      sentiment: 'FRUSTRATED',
    });

    await handleInboundMessage(makeJob(), deps as never);

    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'conv-1' }, data: expect.objectContaining({ status: 'ESCALATED' }) }),
    );
    expect(deps.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ESCALATED_TO_HUMAN', entityId: 'conv-1' }),
    );
    expect(deps.whatsapp.sendText).toHaveBeenCalledWith('2348012345678', 'Connecting you with a human representative.');
  });

  it('marks the message FAILED, audits the failure, and rethrows for retry', async () => {
    const prisma = makePrisma();
    prisma.message.findUnique.mockResolvedValueOnce({ id: 'msg-1', text: 'Price?', ...businessCtx });
    prisma.message.create.mockResolvedValueOnce({ id: 'out-3', sentAt: new Date('2026-01-01T00:00:00Z') });
    prisma.message.update
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => {
        throw new Error('transient db error');
      })
      .mockImplementation(async () => ({}));
    const deps = makeDeps(prisma);
    deps.agentRun.mockResolvedValueOnce({ text: 'ok', escalated: false, toolCalls: [] });

    await expect(handleInboundMessage(makeJob(), deps as never)).rejects.toThrow('transient db error');

    expect(prisma.message.update).toHaveBeenNthCalledWith(3, { where: { id: 'msg-1' }, data: { status: MESSAGE_STATUS.FAILED } });
    expect(deps.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MESSAGE_INGEST_FAILED', details: expect.objectContaining({ jobId: 'job-1' }) }),
    );
  });

  it('answers with the kill-switch fallback and skips the AI agent when the kill switch is active', async () => {
    const prisma = makePrisma();
    prisma.message.findUnique.mockResolvedValueOnce({ id: 'msg-1', text: 'Price?', ...businessCtx });
    prisma.message.create.mockResolvedValueOnce({ id: 'out-ks', sentAt: new Date('2026-01-01T00:00:00Z') });
    const deps = makeDeps(prisma);
    deps.killSwitch.isActive.mockResolvedValueOnce(true);

    await handleInboundMessage(makeJob(), deps as never);

    expect(deps.killSwitch.isActive).toHaveBeenCalled();
    expect(deps.agentRun).not.toHaveBeenCalled();
    expect(deps.whatsapp.sendText).toHaveBeenCalledWith('2348012345678', "Thanks for your message — we'll reply shortly.");
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ direction: MESSAGE_DIRECTION.OUTBOUND, type: 'text', status: MESSAGE_STATUS.SENT }),
      }),
    );
    expect(prisma.message.update).toHaveBeenNthCalledWith(2, { where: { id: 'msg-1' }, data: { status: MESSAGE_STATUS.PROCESSED } });
  });
});

describe('handleInboundMessage audio (Phase 3 voice notes)', () => {
  const audioMessage = {
    id: 'msg-audio-1',
    text: null,
    type: 'audio',
    mediaMimeType: 'audio/ogg; codecs=opus',
    payload: { message: { audio: { id: 'MEDIA_123' } } },
    ...businessCtx,
  };

  it('downloads, transcribes, stores the transcription, and runs the agent with a clear voiceNote', async () => {
    const prisma = makePrisma();
    prisma.message.findUnique.mockResolvedValueOnce(audioMessage);
    prisma.message.create.mockResolvedValueOnce({ id: 'out-a1', sentAt: new Date('2026-01-01T00:00:00Z') });
    const deps = makeDeps(prisma);
    deps.transcribe.mockResolvedValueOnce({ text: 'ina bukatar rice 50kg', language: 'ha', confidence: 0.92, clear: true });
    deps.agentRun.mockResolvedValueOnce({ text: 'Kuna son bags nawa?', escalated: false, toolCalls: ['search_products'] });

    await handleInboundMessage(makeJob({ data: { ...makeJob().data, messageId: 'msg-audio-1' } }), deps as never);

    expect(deps.whatsapp.downloadMedia).toHaveBeenCalledWith('MEDIA_123');
    expect(deps.transcribe).toHaveBeenCalledWith({
      buffer: Buffer.from('fake-audio-bytes'),
      mimeType: 'audio/ogg; codecs=opus',
    });
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'msg-audio-1' },
        data: expect.objectContaining({
          transcription: 'ina bukatar rice 50kg',
          mediaUrl: 'MEDIA_123',
        }),
      }),
    );
    expect(deps.agentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceNote: { text: 'ina bukatar rice 50kg', language: 'ha', confidence: 0.92, clear: true },
      }),
    );
    expect(deps.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'VOICE_NOTE_TRANSCRIBED', details: expect.objectContaining({ mediaId: 'MEDIA_123', language: 'ha' }) }),
    );
    expect(deps.whatsapp.sendText).toHaveBeenCalledWith('2348012345678', 'Kuna son bags nawa?');
  });

  it('skips the agent and sends a canned reply when the voice note is over the duration cap', async () => {
    const prisma = makePrisma();
    prisma.message.findUnique.mockResolvedValueOnce({
      ...audioMessage,
      payload: { message: { audio: { id: 'MEDIA_123', duration: 600 } } },
    });
    prisma.message.create.mockResolvedValueOnce({ id: 'out-cap', sentAt: new Date('2026-01-01T00:00:00Z') });
    const deps = makeDeps(prisma);

    await handleInboundMessage(makeJob({ data: { ...makeJob().data, messageId: 'msg-audio-1' } }), deps as never);

    expect(deps.whatsapp.downloadMedia).not.toHaveBeenCalled();
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.agentRun).not.toHaveBeenCalled();
    expect(deps.whatsapp.sendText).toHaveBeenCalledWith('2348012345678', expect.stringContaining('long'));
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ direction: MESSAGE_DIRECTION.OUTBOUND, type: 'text', status: MESSAGE_STATUS.SENT }),
      }),
    );
  });

  it('feeds an unclear transcript to the agent as an unclear voiceNote (agent asks to repeat)', async () => {
    const prisma = makePrisma();
    prisma.message.findUnique.mockResolvedValueOnce(audioMessage);
    prisma.message.create.mockResolvedValueOnce({ id: 'out-a2', sentAt: new Date('2026-01-01T00:00:00Z') });
    const deps = makeDeps(prisma);
    deps.transcribe.mockResolvedValueOnce({ text: '', language: 'ha', confidence: 0.2, clear: false });
    deps.agentRun.mockResolvedValueOnce({
      text: 'Yi haƙuri, ban ji maganarka ba. Don Allah ka sake maimaita.',
      escalated: false,
      toolCalls: [],
    });

    await handleInboundMessage(makeJob({ data: { ...makeJob().data, messageId: 'msg-audio-1' } }), deps as never);

    expect(deps.agentRun).toHaveBeenCalledWith(
      expect.objectContaining({ voiceNote: { text: '', language: 'ha', confidence: 0.2, clear: false } }),
    );
    expect(deps.whatsapp.sendText).toHaveBeenCalledWith('2348012345678', 'Yi haƙuri, ban ji maganarka ba. Don Allah ka sake maimaita.');
  });

  it('skips the agent when an audio message has no downloadable media id', async () => {
    const prisma = makePrisma();
    prisma.message.findUnique.mockResolvedValueOnce({ ...audioMessage, payload: { message: {} } });
    const deps = makeDeps(prisma);

    await handleInboundMessage(makeJob({ data: { ...makeJob().data, messageId: 'msg-audio-1' } }), deps as never);

    expect(deps.whatsapp.downloadMedia).not.toHaveBeenCalled();
    expect(deps.agentRun).not.toHaveBeenCalled();
  });

  it('still answers other media (e.g. image) as before — agent skipped', async () => {
    const prisma = makePrisma();
    prisma.message.findUnique.mockResolvedValueOnce({ id: 'msg-img-1', text: null, type: 'image', payload: { message: { image: { id: 'IMG_1' } } }, ...businessCtx });
    const deps = makeDeps(prisma);

    await handleInboundMessage(makeJob({ data: { ...makeJob().data, messageId: 'msg-img-1' } }), deps as never);

    expect(deps.whatsapp.downloadMedia).not.toHaveBeenCalled();
    expect(deps.agentRun).not.toHaveBeenCalled();
  });
});