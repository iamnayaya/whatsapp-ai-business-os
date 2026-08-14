import { Prisma, type PrismaClient } from '../../db/src';
import type { AppLogger } from '../../shared/src';
import { AUDIT_ACTOR, messageFromError } from '../../shared/src';

export type AuditActor = (typeof AUDIT_ACTOR)[keyof typeof AUDIT_ACTOR];

export interface AuditInput {
  businessId: string;
  actorType: AuditActor;
  actorId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}

export interface AuditServiceDeps {
  prisma: PrismaClient;
  logger: AppLogger;
}

export class AuditService {
  constructor(private readonly deps: AuditServiceDeps) {}

  async record(input: AuditInput): Promise<void> {
    try {
      await this.deps.prisma.agentAction.create({
        data: {
          businessId: input.businessId,
          actorType: input.actorType,
          actorId: input.actorId ?? null,
          action: input.action,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          details: (input.details ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // Audit must never break the main business flow, but a broken audit
      // trail is a serious signal — log it loudly.
      this.deps.logger.error('audit.record failed', {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        error: messageFromError(err),
      });
    }
  }
}

export function createAuditService(deps: AuditServiceDeps): AuditService {
  return new AuditService(deps);
}