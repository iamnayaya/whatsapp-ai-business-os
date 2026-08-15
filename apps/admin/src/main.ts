import 'dotenv/config';
import { readFileSync } from 'fs';
import * as readline from 'readline';
import { loadEnv, createLogger } from '../../../packages/shared/src';
import { createPrismaClient } from '../../../packages/db/src';
import { createAuditService } from '../../../packages/audit/src';
import { createLlmClient, CatalogGenerator } from '../../../packages/ai/src';
import { CatalogService, type CatalogImportItem, type GeneratedListing } from './catalog.service';

/**
 * Phase 4 admin CLI: generate product listings from photos with a human
 * review gate. Supports single and bulk (--manifest) uploads.
 *
 * Examples:
 *   npm run admin -- --image ./photo.jpg --price 85000 --quantity 40
 *   npm run admin -- --manifest ./bulk.json
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.GEMINI_API_KEY && !env.XAI_API_KEY) throw new Error('XAI_API_KEY or GEMINI_API_KEY is required (vision model)');
  const args = parseArgs(process.argv.slice(2));

  const logger = createLogger('catalog-cli');
  const prisma = createPrismaClient();
  const audit = createAuditService({ prisma, logger });
  const llm = createLlmClient({
    xaiApiKey: env.XAI_API_KEY,
    xaiModel: env.XAI_MODEL,
    xaiBaseUrl: env.XAI_BASE_URL,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    logger: logger.child('llm'),
  });

  const business =
    (await prisma.business.findFirst()) ??
    (await prisma.business.create({
      data: {
        name: env.BUSINESS_NAME,
        phoneNumber: env.BUSINESS_PHONE_NUMBER ?? 'catalog-cli',
        currency: env.BUSINESS_CURRENCY,
        timezone: env.BUSINESS_TIMEZONE,
      },
    }));

  const items = buildItems(args);

  const service = new CatalogService({
    prisma,
    audit,
    logger,
    generator: new CatalogGenerator(llm, { businessName: business.name, currency: business.currency }),
    reviewer: interactiveReviewer,
    businessId: business.id,
    currency: business.currency,
  });

  const summary = await service.importImages(items);

  console.log('\n=== Import summary ===');
  console.log(`total: ${summary.total}`);
  console.log(`published: ${summary.published}`);
  console.log(`image rejected: ${summary.imageRejected}`);
  console.log(`review rejected: ${summary.reviewRejected}`);
  console.log(`failed: ${summary.failed}`);
  for (const r of summary.items) {
    console.log(`  - ${r.filename}: ${r.status}${r.sku ? ` (sku ${r.sku})` : ''}${r.reason ? ` — ${r.reason}` : ''}`);
  }

  await prisma.$disconnect();
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) {
        out[key] = val;
        i++;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

function buildItems(args: Record<string, string>): CatalogImportItem[] {
  if (args.manifest) {
    const raw = JSON.parse(readFileSync(args.manifest, 'utf8')) as Array<{ path: string; price: number; quantity: number; category?: string; sku?: string }>;
    return raw.map((entry) => ({ buffer: readFileSync(entry.path), mimeType: mimeFor(entry.path), filename: entry.path, ...entry }));
  }
  if (!args.image) throw new Error('Provide --image <path> or --manifest <bulk.json>');
  return [
    {
      buffer: readFileSync(args.image),
      mimeType: mimeFor(args.image),
      filename: args.image,
      price: Number(args.price),
      quantity: Number(args.quantity),
      category: args.category,
      sku: args.sku,
    },
  ];
}

const interactiveReviewer = async (input: { filename: string; listing: GeneratedListing }) => {
  console.log(`\n=== Proposed listing for ${input.filename} ===`);
  console.log(`Title: ${input.listing.title}`);
  console.log(`Category: ${input.listing.category || '(suggest)'}`);
  console.log(`Tags: ${input.listing.tags.join(', ')}`);
  console.log(`Description:\n${input.listing.description}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await ask(rl, '\nApprove [a], edit description [e], or reject [r]? ');
  rl.close();

  if (answer === 'r' || answer === 'reject') return { action: 'reject' as const };
  if (answer === 'e' || answer === 'edit') {
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const description = await ask(rl2, 'New description: ');
    rl2.close();
    return { action: 'edit' as const, description };
  }
  return { action: 'approve' as const };
};

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve));
}

function mimeFor(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('Catalog CLI failed:', err?.message ?? err);
    process.exit(1);
  },
);