import 'dotenv/config';
import { loadEnv } from '../../shared/src/env';
import { createPrismaClient } from '../src/client';
import seedProducts from '../seeds/products.json';

interface SeedProduct {
  sku: string;
  name: string;
  description?: string;
  price: number;
  currency?: string;
  category?: string;
  stock?: number;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = createPrismaClient();

  const products: SeedProduct[] = seedProducts as SeedProduct[];

  const business =
    (await prisma.business.findFirst()) ??
    (await prisma.business.create({
      data: {
        name: env.BUSINESS_NAME,
        phoneNumber: env.BUSINESS_PHONE_NUMBER ?? 'seed',
        currency: env.BUSINESS_CURRENCY,
        timezone: env.BUSINESS_TIMEZONE,
      },
    }));

  let created = 0;
  let updated = 0;
  for (const seed of products) {
    const existing = await prisma.product.findFirst({
      where: { businessId: business.id, name: seed.name },
    });

    const product =
      existing ??
      (await prisma.product.create({
        data: {
          businessId: business.id,
          sku: seed.sku,
          name: seed.name,
          description: seed.description ?? null,
          price: seed.price,
          currency: seed.currency ?? business.currency,
          category: seed.category ?? null,
        },
      }));

    if (existing) {
      await prisma.product.update({
        where: { id: existing.id },
        data: {
          sku: seed.sku,
          description: seed.description ?? null,
          price: seed.price,
          category: seed.category ?? null,
        },
      });
      updated++;
    } else {
      created++;
    }

    await prisma.stockLevel.upsert({
      where: { productId: product.id },
      create: { productId: product.id, quantity: seed.stock ?? 0 },
      update: { quantity: seed.stock ?? 0 },
    });
  }

  console.log(`Seeded ${created} product(s), updated ${updated} product(s) for business "${business.name}".`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});