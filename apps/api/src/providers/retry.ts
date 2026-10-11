import { ProviderError } from './types';

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 1000, maxDelayMs: 15000 };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ProviderError('Cancelled', 'retry', false));
    });
  });

/** Exponential backoff with deterministic jitter; only ProviderError.retryable failures are retried. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, policy: RetryPolicy = DEFAULT_RETRY, onRetry?: (e: ProviderError, attempt: number, delayMs: number) => void, signal?: AbortSignal): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      last = e;
      const retryable = e instanceof ProviderError && e.retryable;
      if (!retryable || attempt === policy.attempts) throw e;
      const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1) * (1 + (attempt % 3) * 0.1));
      onRetry?.(e as ProviderError, attempt, delay);
      await sleep(delay, signal);
    }
  }
  throw last;
}

export async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms: number, label: string, parent?: AbortSignal): Promise<T> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  parent?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await Promise.race([
      p(ctrl.signal),
      new Promise<never>((_, reject) => ctrl.signal.addEventListener('abort', () => reject(new ProviderError(`${label} timed out after ${ms} ms`, label, true)))),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onAbort);
  }
}
