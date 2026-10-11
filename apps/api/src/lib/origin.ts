import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';

/**
 * The public origin the app is being reached at, learned from incoming requests (behind Vercel's
 * proxy). Used by the serverless job runner to continue long jobs in a fresh invocation.
 */
let lastOrigin: string | null = null;
export function rememberOrigin(req: Request, _res: Response, next: NextFunction) {
  const host = req.get('x-forwarded-host') ?? req.get('host');
  if (host && /^[a-zA-Z0-9.-]+(:\d+)?$/.test(host)) lastOrigin = `${req.protocol}://${host}`;
  next();
}
export function appOrigin(): string | null {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (lastOrigin) return lastOrigin;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return null;
}

/** Per-job token for the internal continuation endpoint (derived from APP_SECRET). */
export function internalJobToken(jobId: string) {
  return createHmac('sha256', config().APP_SECRET).update(`job-continue:${jobId}`).digest('hex');
}
export function verifyInternalJobToken(jobId: string, token: unknown) {
  if (typeof token !== 'string' || token.length !== 64) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(internalJobToken(jobId)));
}
