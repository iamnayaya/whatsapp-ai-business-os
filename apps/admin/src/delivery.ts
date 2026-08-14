import 'dotenv/config';
import { loadEnv, createLogger, DELIVERY_STATUS, AUDIT_ACTIONS, AUDIT_ACTOR, ORDER_STATUS } from '../../../packages/shared/src';
import { createPrismaClient } from '../../../packages/db/src';
import { createAuditService } from '../../../packages/audit/src';
import { isValidDeliveryTransition, nextDeliveryStates, normalizeDeliveryStatus } from './delivery.rules';

/**
 * Phase 7 delivery status CLI — manual fulfilment tracking. The logistics
 * agent reports the status via get_order_status; a human (or an external
 * fulfilment system) advances it here:
 *
 *   PENDING -> PROCESSING -> SHIPPED -> DELIVERED
 *
 * Transitions are one-way and validated. Example:
 *   npm run admin:delivery -- --order <orderId> --status shipped
 */

async function main(): Promise<void> {
  const env = loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const orderId = args.order;
  const nextRaw = args.status;
  if (!orderId || !nextRaw) {
    throw new Error('Usage: admin:delivery -- --order <orderId> --status <processing|shipped|delivered>');
  }
  const next = normalizeDeliveryStatus(nextRaw);
  if (!next) {
    throw new Error(`Invalid --status "${nextRaw}" — use processing, shipped, or delivered`);
  }

  const logger = createLogger('delivery-cli');
  const prisma = createPrismaClient();
  const audit = createAuditService({ prisma, logger });

  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { business: true } });
  if (!order) throw new Error(`Order not found: ${orderId}`);

  if (order.status === ORDER_STATUS.CANCELLED || order.status === ORDER_STATUS.REFUNDED) {
    throw new Error(`Cannot update delivery: order is ${order.status.toLowerCase()}`);
  }
  if (order.status !== ORDER_STATUS.PAID && order.status !== ORDER_STATUS.FULFILLING) {
    throw new Error(`Cannot update delivery: order is ${order.status.toLowerCase()} (only paid/fulfilling orders ship)`);
  }

  const current = order.deliveryStatus ?? DELIVERY_STATUS.PENDING;
  if (!isValidDeliveryTransition(current, next)) {
    throw new Error(`Invalid transition ${current} -> ${next} (allowed: ${nextDeliveryStates(current).join(', ') || 'none'})`);
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      deliveryStatus: next,
      ...(next === DELIVERY_STATUS.DELIVERED
        ? { status: ORDER_STATUS.FULFILLED, fulfilledAt: new Date() }
        : {}),
    },
  });

  await audit.record({
    businessId: order.businessId,
    actorType: AUDIT_ACTOR.OWNER,
    action: AUDIT_ACTIONS.DELIVERY_STATUS_UPDATED,
    entityType: 'ORDER',
    entityId: order.id,
    details: { from: current, to: next, trackingReference: order.trackingReference ?? null },
  });

  console.log(`Order ${order.id} (${order.business.name})`);
  console.log(`  tracking: ${order.trackingReference ?? '(none)'}`);
  console.log(`  delivery: ${current} -> ${next}${next === DELIVERY_STATUS.DELIVERED ? ' (order fulfilled)' : ''}`);

  await prisma.$disconnect();
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
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

main().then(
  () => process.exit(0),
  (err) => {
    console.error('Delivery CLI failed:', err?.message ?? err);
    process.exit(1);
  },
);