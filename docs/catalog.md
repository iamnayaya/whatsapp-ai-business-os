# Phase 4 — Auto Catalog Generation

The owner uploads a product photo plus basic info (price, quantity, optional category/SKU).
Gemini's vision model drafts a clean listing — title, description, tags, category — in the
business's tone. A **human review gate** decides approve / edit / reject before anything is
published. Bulk uploads (multiple images) run with a progress summary at the end.

## I/O

### CLI

```bash
# Single product
npm run admin:catalog -- --image ./photo.jpg --price 85000 --quantity 40

# Single product with category/SKU hints
npm run admin:catalog -- --image ./soap.jpg --price 2500 --quantity 100 --category "Personal Care" --sku SOAP-001

# Bulk upload (JSON manifest of per-image info)
npm run admin:catalog -- --manifest ./bulk.json
```

`bulk.json` shape:

```json
[
  { "path": "./rice.jpg",  "price": 85000, "quantity": 40, "category": "Groceries" },
  { "path": "./soap.jpg",  "price": 2500,  "quantity": 100 },
  { "path": "./blurry.jpg", "price": 0,     "quantity": 0 }
]
```

For each image the CLI:
1. Sends the photo + `CatalogBasicInfo` to the vision model.
2. Prints the proposed listing and prompts `[a]pprove, [e]dit description, [r]eject`.
3. On approve/edit, creates the Product (`isActive: true`) + a `StockLevel` row, then audits.

The manifest (not single-flag) path is required for bulk so each image can carry its own
price/quantity.

## How it works

- `packages/ai/src/catalog.ts` — `CatalogGenerator`. Enforces two hard rules via
  `buildCatalogPrompt`:
  1. Only describe what is **visible** in the photo — never invent brand, weight, size,
     capacity, or features.
  2. If the image is blurry / dark / unclear / has no recognisable product, return
     `usable:false` instead of guessing.
  Also sanity-gates price (`>= 0`) and quantity (non-negative integer) before any model call.
- `packages/ai/src/client.ts` — `GeminiClient.analyzeImage` (vision inline-data call, same
  retry/classify policy as `generate`/`transcribeAudio`).
- `apps/admin/src/catalog.service.ts` — `CatalogService.importImages`: per-item
  generate → review → publish → audit, isolating failures so one bad image can't abort a batch.
  The reviewer is injected, so the CLI wires it to the terminal and tests inject a stub.
- `apps/admin/src/main.ts` — the CLI entry.

## DB effects

| Table | What gets written |
|---|---|
| `products` | one row per approved image: `name`, `description`, `price`, `currency`, `category`, `isActive=true`, `sku` (auto or provided), `metadata.tags` |
| `stock_levels` | one row per product: `quantity` from the item, `reserved=0` |
| `agent_actions` | audit: `CATALOG_IMAGE_REJECTED` (AI), `CATALOG_REVIEWED` (owner decision), `PRODUCT_CREATED` (owner) |

No schema migration was needed — `metadata` (Json) already existed for tags.

## Quality gate (never hallucinate)

A photo that the model flags `usable:false` — or a malformed / non-JSON model response — is
reported as `image_rejected` with the reason and **never published**. The owner is asked to
retake the photo. This mirrors the Phase 3 voice-note "never fabricate a transcript" rule.

## Tests

```bash
npx vitest run packages/ai/test/catalog.spec.ts        # 11: parse, prompt, generator, quality gate
npx vitest run apps/admin/test/catalog.service.spec.ts # 7: publish, blurry, review-reject/edit, bulk 5+, failure isolation
```

Bulk-upload coverage uses a 5-image batch asserting the summary breakdown
(`published`/`imageRejected`/`reviewRejected`/`failed`) and that a throwing item doesn't
abort the rest. All model calls go through the `VisionLlm` seam — tests never touch the network.

## Status

Phase 4 complete ✅. Next: Phase 5 (follow-up / abandoned-cart).