import { describe, expect, it, vi } from 'vitest';
import { AuditService, type AuditInput } from '../src/index';
import { createLogger } from '../../shared/src/logger';

const silentLogger = createLogger('test', { destination: () => undefined });

function auditInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    businessId: 'biz-1',
    actorType: 'AI_AGENT',
    action: 'ORDER_CREATED',
    entityType: 'ORDER',
    entityId: 'ord-1',
    details: { total: 8000 },
    ...overrides,
  };
}

describe('AuditService', () => {
  it('persists an audit entry to agent_actions', async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = { agentAction: { create } } as never;
    const service = new AuditService({ prisma, logger: silentLogger });
    await service.record(auditInput());
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        businessId: 'biz-1',
        actorType: 'AI_AGENT',
        action: 'ORDER_CREATED',
        entityType: 'ORDER',
        entityId: 'ord-1',
        details: { total: 8000 },
      }),
    });
  });

  it('never throws when the audit write fails, but logs the error', async () => {
    const errorSpy = vi.fn();
    const logger = { ...silentLogger, error: errorSpy };
    const prisma = { agentAction: { create: vi.fn().mockRejectedValue(new Error('db down')) } } as never;
    const service = new AuditService({ prisma, logger });
    await expect(service.record(auditInput())).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('audit.record failed', expect.objectContaining({ action: 'ORDER_CREATED' }));
  });
});