import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../lib/audit';
import { createSession, destroySession } from '../lib/auth';
import { hashPassword, verifyPassword } from '../lib/crypto';
import { conflict, HttpError } from '../lib/errors';
import { defineRoute } from '../lib/route';

export const authRouter = Router();
// Brute-force protection on credential endpoints.
authRouter.use(['/auth/login', '/auth/register'], rateLimit({ windowMs: 15 * 60_000, limit: process.env.NODE_ENV === 'test' ? 1000 : 20, standardHeaders: true, legacyHeaders: false }));

const Password = z.string().min(10, 'Use at least 10 characters').max(200);
const Register = z.object({ email: z.string().email().max(200).transform((e) => e.toLowerCase()), name: z.string().trim().min(1).max(100), password: Password, workspaceName: z.string().trim().max(100).optional().transform((v) => v || undefined) });
const Login = z.object({ email: z.string().email().transform((e) => e.toLowerCase()), password: z.string().min(1).max(200) });
const Me = z.object({ user: z.object({ id: z.string(), email: z.string(), name: z.string() }), workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: z.string() })), activeWorkspaceId: z.string().nullable() });

async function me(userId: string, active: string | null) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { memberships: { include: { workspace: true } } } });
  return {
    user: { id: user.id, email: user.email, name: user.name },
    workspaces: user.memberships.map((m) => ({ id: m.workspaceId, name: m.workspace.name, role: m.role })),
    activeWorkspaceId: active,
  };
}

defineRoute(authRouter, { method: 'post', path: '/auth/register', summary: 'Create an account and personal workspace', tag: 'Auth', auth: 'public', body: Register, response: Me, status: 201 }, async ({ req, res, body }) => {
  if (await prisma.user.findUnique({ where: { email: body.email } })) throw conflict('An account with this email already exists.');
  const passwordHash = await hashPassword(body.password);
  const user = await prisma.user.create({
    data: { email: body.email, name: body.name, passwordHash, memberships: { create: { role: 'OWNER', workspace: { create: { name: body.workspaceName ?? `${body.name}'s workspace` } } } } },
    include: { memberships: true },
  });
  const ws = user.memberships[0].workspaceId;
  await createSession(user.id, req, res, ws);
  await audit(null, 'user.register', 'User', user.id, { email: body.email }, ws);
  return me(user.id, ws);
});

defineRoute(authRouter, { method: 'post', path: '/auth/login', summary: 'Sign in', tag: 'Auth', auth: 'public', body: Login, response: Me }, async ({ req, res, body }) => {
  const user = await prisma.user.findUnique({ where: { email: body.email }, include: { memberships: true } });
  // Same error and similar timing for unknown email vs wrong password.
  const ok = user ? await verifyPassword(body.password, user.passwordHash) : await verifyPassword(body.password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!user || !ok) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  const ws = user.memberships[0]?.workspaceId ?? null;
  await createSession(user.id, req, res, ws);
  await audit(null, 'user.login', 'User', user.id, undefined, ws);
  return me(user.id, ws);
});

defineRoute(authRouter, { method: 'post', path: '/auth/logout', summary: 'Sign out', tag: 'Auth', auth: 'user' }, async ({ req, res }) => {
  await destroySession(req, res);
  return { ok: true };
});

defineRoute(authRouter, { method: 'get', path: '/auth/me', summary: 'Current user and workspaces', tag: 'Auth', auth: 'user', response: Me }, async ({ auth }) => me(auth.user.id, auth.workspaceId));

defineRoute(authRouter, { method: 'post', path: '/auth/password', summary: 'Change password (signs out other sessions)', tag: 'Auth', auth: 'user', body: z.object({ currentPassword: z.string(), newPassword: Password }) }, async ({ req, auth, body }) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
  if (!(await verifyPassword(body.currentPassword, user.passwordHash))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect.');
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } });
  await prisma.session.deleteMany({ where: { userId: user.id, id: { not: auth.session.id } } });
  await audit(req, 'user.password_change', 'User', user.id);
  return { ok: true };
});
