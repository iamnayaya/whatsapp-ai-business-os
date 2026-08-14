import { describe, expect, it } from 'vitest';
import { InvalidWebhookPayloadError, parseWebhookEnvelope } from '../src/webhook/schemas';

const baseTimestamp = String(Math.floor(Date.now() / 1000));

function textMessageEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15551234567', phone_number_id: 'PHONE_NUMBER_ID' },
              contacts: [{ profile: { name: 'Amina' }, wa_id: '2348012345678' }],
              messages: [
                {
                  from: '2348012345678',
                  id: 'wamid.001',
                  timestamp: baseTimestamp,
                  type: 'text',
                  text: { body: 'How much is the red sneakers?' },
                },
              ],
              ...overrides,
            },
          },
        ],
      },
    ],
  };
}

describe('parseWebhookEnvelope', () => {
  it('parses a text message', () => {
    const envelope = parseWebhookEnvelope(textMessageEnvelope());
    const value = envelope.entry[0].changes[0].value;
    expect(value.messages?.[0].text?.body).toBe('How much is the red sneakers?');
    expect(value.messages?.[0].type).toBe('text');
    expect(value.contacts?.[0].wa_id).toBe('2348012345678');
  });

  it('parses a voice-note (audio) message and preserves media id', () => {
    const envelope = parseWebhookEnvelope(
      textMessageEnvelope({
        messages: [
          {
            from: '2348012345678',
            id: 'wamid.audio.001',
            timestamp: baseTimestamp,
            type: 'audio',
            audio: { id: 'MEDIA_AUDIO_1', mime_type: 'audio/ogg; codecs=opus' },
          },
        ],
      }),
    );
    const msg = envelope.entry[0].changes[0].value.messages?.[0];
    expect(msg?.type).toBe('audio');
    expect(msg?.audio?.id).toBe('MEDIA_AUDIO_1');
  });

  it('parses interactive button replies', () => {
    const envelope = parseWebhookEnvelope(
      textMessageEnvelope({
        messages: [
          {
            from: '2348012345678',
            id: 'wamid.interactive.001',
            timestamp: baseTimestamp,
            type: 'interactive',
            interactive: { type: 'button_reply', button_reply: { id: 'btn-1', title: 'Yes, order' } },
          },
        ],
      }),
    );
    const msg = envelope.entry[0].changes[0].value.messages?.[0];
    expect(msg?.type).toBe('interactive');
    expect(msg?.interactive?.button_reply?.title).toBe('Yes, order');
  });

  it('parses interactive list replies', () => {
    const envelope = parseWebhookEnvelope(
      textMessageEnvelope({
        messages: [
          {
            from: '2348012345678',
            id: 'wamid.list.001',
            timestamp: baseTimestamp,
            type: 'interactive',
            interactive: { type: 'list_reply', list_reply: { id: 'list-2', title: 'Nike Air Force', description: 'size 43' } },
          },
        ],
      }),
    );
    const msg = envelope.entry[0].changes[0].value.messages?.[0];
    expect(msg?.interactive?.list_reply?.title).toBe('Nike Air Force');
  });

  it('parses delivery statuses', () => {
    const envelope = parseWebhookEnvelope(
      textMessageEnvelope({
        messages: undefined,
        statuses: [
          { id: 'wamid.001', status: 'delivered', timestamp: baseTimestamp, recipient_id: '2348012345678' },
        ],
      }),
    );
    const value = envelope.entry[0].changes[0].value;
    expect(value.statuses?.[0].status).toBe('delivered');
    expect(value.messages).toBeUndefined();
  });

  it('tolerates unknown fields (Meta forward compatibility)', () => {
    const envelope = parseWebhookEnvelope(textMessageEnvelope({ some_new_field: { x: 1 } }));
    expect(envelope.entry.length).toBe(1);
  });

  it('throws InvalidWebhookPayloadError on a malformed envelope', () => {
    expect(() => parseWebhookEnvelope({ object: 'oops' })).toThrow(InvalidWebhookPayloadError);
    expect(() => parseWebhookEnvelope({ entry: [{ changes: [{ field: 'messages' }] }] })).toThrow(
      InvalidWebhookPayloadError,
    );
  });
});