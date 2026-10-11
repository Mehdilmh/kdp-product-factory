import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from '../db';

export async function audit(req: Request | null, action: string, entityType: string, entityId: string | null, details?: Prisma.InputJsonValue, workspaceId?: string | null) {
  await prisma.auditLog.create({
    data: { workspaceId: workspaceId ?? req?.auth?.workspaceId ?? null, userId: req?.auth?.user.id ?? null, action, entityType, entityId, details, ip: req?.ip ?? null },
  });
}
