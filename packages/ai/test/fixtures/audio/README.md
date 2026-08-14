# Voice note test fixtures

Place **3 sample voice note clips** here (WhatsApp-format audio works best —
`.ogg`/`.opus`, `.mp3`, `.wav`, `.m4a`, `.aac`). The test
`packages/ai/test/voice-clips.spec.ts` runs the real transcriber against them
when `GEMINI_API_KEY` is set and the files exist; otherwise the test **skips**.

Expected filenames:

| File | Language covered | Suggested content |
|---|---|---|
| `hausa.ogg` | Hausa | e.g. "Ina bukatar rice 50kg, nawa ne kudin?" |
| `pidgin.ogg` | Nigerian Pidgin | e.g. "Abeg, how much na dis rice? I wan buy two." |
| `mixed.ogg` | Mixed / code-switching | e.g. "Hello, how far. Ina son order — I want one bag." |

Rules:
- Keep clips short (< 60s), clear, single speaker.
- No need to include real customer data — sample phrases are fine.
- The test asserts the transcript is non-empty, `confidence` is reported, and
  the detected language matches the expected one from `expected-languages.ts`.

To (re)generate this test's expectations after adding new clips, run:

```bash
GEMINI_API_KEY=... npx vitest run packages/ai/test/voice-clips.spec.ts
```