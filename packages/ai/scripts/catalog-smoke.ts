import 'dotenv/config';
import { readFileSync } from 'fs';
import { loadEnv, createLogger } from '../../../packages/shared/src';
import { GeminiClient, CatalogGenerator } from '../../../packages/ai/src';

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY required');
  const logger = createLogger('catalog-smoke', { destination: () => undefined });
  const llm = new GeminiClient({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, logger: logger.child('gemini') });
  const generator = new CatalogGenerator(llm, { businessName: env.BUSINESS_NAME, currency: env.BUSINESS_CURRENCY });

  const buffer = readFileSync(process.argv[2]);
  const result = await generator.generate({ buffer, mimeType: 'image/png', info: { price: 85000, quantity: 40 } });

  console.log('usable:', result.usable);
  if (result.reason) console.log('reason:', result.reason);
  if (result.listing) console.log(JSON.stringify(result.listing, null, 2));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('SMOKE FAILED:', err?.message ?? err);
    process.exit(1);
  },
);