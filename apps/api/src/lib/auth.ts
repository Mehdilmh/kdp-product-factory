import type { Membership, Role, Session, User } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { prisma } from '../db';
import { randomToken, sha256Hex } from './crypto';
import { forbidden, HttpError } from './errors';

export const SESSION_COOKIE = 'kdp_session';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'kdp-factory';

export interface AuthContext {
  user: Pick<User, 'id' | 'email' | 'name'>;
  session: Session;
  workspaceId: string | null;
  role: Role | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

const RANK: Record<Role, number> = { VIEWER: 0, EDITOR: 1, ADMIN: 2, OWNER: 3 };
export const hasRole = (role: Role | null, min: Role) => role !== null && RANK[role] >= RANK[min];

export async function createSession(userId: string, req: Request, res: Response, workspaceId: string | null) {
  const token = randomToken();
  const ttl = config().SESSION_TTL_DAYS * 86400_000;
  await prisma.session.create({
    data: { tokenHash: sha256Hex(token), userId, activeWorkspaceId: workspaceId, expiresAt: new Date(Date.now() + ttl), ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 300) },
  });
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config().NODE_ENV === 'production', maxAge: ttl, path: '/' });
}

export async function destroySession(req: Request, res: Response) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await prisma.session.deleteMany({ where: { tokenHash: sha256Hex(token) } });
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Loads the session (if any). Never throws for anonymous requests. */
export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && token.length > 20) {
      const session = await prisma.session.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { user: { include: { memberships: true } } } });
      if (session && session.expiresAt > new Date()) {
        const memberships: Membership[] = session.user.memberships;
        // The active workspace must still be one the user belongs to.
        let m = memberships.find((x) => x.workspaceId === session.activeWorkspaceId) ?? memberships[0] ?? null;
        if (m && m.workspaceId !== session.activeWorkspaceId) {
          await prisma.session.update({ where: { id: session.id }, data: { activeWorkspaceId: m.workspaceId } });
        }
        // Sliding expiry, throttled to once a minute.
        if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
          await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + config().SESSION_TTL_DAYS * 86400_000) } });
        }
        req.auth = { user: { id: session.user.id, email: session.user.email, name: session.user.name }, session, workspaceId: m?.workspaceId ?? null, role: m?.role ?? null };
      }
    }
    next();
  } catch (e) {
    next(e);
  }
}

/** CSRF mitigation: state-changing requests must carry a custom header (blocked cross-site by CORS). */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get(CSRF_HEADER) !== CSRF_VALUE) return next(new HttpError(403, 'CSRF', `Missing ${CSRF_HEADER} header`));
  next();
}

export function requireUser(req: Request): AuthContext {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
  return req.auth;
}

export function requireWorkspace(req: Request, min: Role = 'VIEWER'): AuthContext & { workspaceId: string; role: Role } {
  const a = requireUser(req);
  if (!a.workspaceId || !a.role) throw forbidden('No active workspace');
  if (!hasRole(a.role, min)) throw forbidden(`Requires ${min} role or higher`);
  return a as AuthContext & { workspaceId: string; role: Role };
}
