# Module: Voice Note Intelligence (Phase 3)

Customers speak more often than they type in Hausa/Pidgin markets. Phase 3 makes
every incoming **voice note** answerable: the worker downloads the audio from
WhatsApp's media API, transcribes it in-place, and feeds the text into the same
Phase 2 Sales Agent — so ordering, cart, and escalation logic work **unchanged**
for voice.

## How it works

1. **Webhook → message row.** The Phase 1 webhook service already stores audio
   messages (`type: 'audio'`, media metadata in `payload.message.audio.id`).
2. **Worker (`apps/worker/src/handler.ts`).** When an inbound message is audio
   with a media id, the handler:
   - downloads the bytes via `WhatsAppClient.downloadMedia(mediaId)`,
   - transcribes via the injected `Transcriber`,
   - **persists the transcription + language + confidence** on the message row
     (`message.transcription`, `mediaUrl`, payload.transcription) for audit,
   - audits `VOICE_NOTE_TRANSCRIBED`,
   - runs the **same** `agent.run(...)` with a `voiceNote` hint.
3. **Agent (`packages/ai/src/agent.ts`).**
   - `buildContents` maps a clear transcript straight to the user turn, so the
     model answers it as any text message.
   - If the note was **unclear** (empty transcript or low confidence),
     `appendVoiceNoteDirective` injects an instruction to politely ask the
     customer to repeat — **in the language the transcriber detected** — and to
     never guess what was said.
4. **Language detection (`packages/ai/src/transcription.ts`).** Gemini returns a
   `language` label (`ha` / `pcm` / `en` / `other`). `normalizeLanguage` falls
   back to a keyword heuristic for Hausa/Pidgin/English when the label is
   missing or `other`.

## Transcriber

- **Interface:** `Transcriber.transcribe({ buffer, mimeType }) → { text, language, confidence, clear }`.
- **Production impl:** `GeminiTranscriber` wraps `GeminiClient.transcribeAudio`,
  which sends the raw audio bytes to **Gemini Flash** (native audio
  understanding — no separate STT vendor, reuses `GEMINI_API_KEY`). The model
  returns strict JSON `{ text, language, confidence }`; a transcript is `clear`
  only when non-empty and `confidence >= 0.5` (configurable via `minConfidence`).
- **Swap seam:** the interface means ElevenLabs Scribe / Google Chirp / etc. can
  drop in without touching the worker or agent.
- **Failure mode:** if the LLM call throws or returns garbage, the transcriber
  returns an *unclear* result (`clear:false`) rather than crashing — the
  customer is politely asked to repeat.

## Why Gemini (and not the usual STT vendors)

| Provider | Hausa accuracy (FLEURS WER) | Pidgin | Cost |
|---|---|---|---|
| **Gemini Flash (this build)** | ~27.5% | good (code-switch aware) | fractions of a cent / min, key already in stack |
| ElevenLabs Scribe | ~3.1% | good | ~$0.004–0.04/min (second vendor) |
| Google Chirp 2 | dedicated `ha-NG` | none (treated as English) | ~$0.72–1.44/hr |
| OpenAI Whisper (API) | ~94% | weak | $0.006/min |
| Deepgram Nova-3 | ~99% (unsupported) | none | $0.0043–0.0077/min |

Whisper and Deepgram are great for English but measurably weak on tonal African
languages; Scribe/Chirp are the accuracy upgrade path if you outgrow Gemini.

## Testing

Unit (offline, no Docker, no network):

```bash
npm test
```

- `packages/ai/test/transcription.spec.ts` — JSON parsing, confidence gate,
  language detection (Hausa/Pidgin/English), `other` fallback, LLM-throw safety.
- `packages/ai/test/agent.spec.ts` — clear voice note flows as text; unclear
  note injects the ask-to-repeat directive with the right language label.
- `apps/worker/test/handler.spec.ts` — download → transcribe → persist → audit →
  agent reply; unclear-note path; no-media-id skip; other-media skip.

Real audio (needs your 3 sample clips + `GEMINI_API_KEY`):

```bash
# 1. Drop hausa.ogg / pidgin.ogg / mixed.ogg into packages/ai/test/fixtures/audio/
#    (see that folder's README for the expected content)
# 2. Run with the key set
GEMINI_API_KEY=... npx vitest run packages/ai/test/voice-clips.spec.ts
```

The fixture tests **skip** when the clips or key are absent, so CI stays green
until you provide them.

## Try it locally

```bash
npm run dev:api
npm run dev:worker
# ngrok the webhook, then send a voice note to your WhatsApp business number:
#   Hausa:  "Ina bukatar rice 50kg"
#   Pidgin: "Abeg how much be dis rice?"
#   Mixed:  "Hello, how far. I want one bag of rice."
```
