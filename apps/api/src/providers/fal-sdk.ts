import { ApiError, createFalClient, ValidationError, type FalClient } from '@fal-ai/client';
import { ProviderError, type FetchLike } from './types';

/**
 * Adapter around the official @fal-ai/client SDK (server-side only).
 *
 * Submit → record request id → wait → fetch result are separate steps so a retry after a
 * network failure resumes the *same* request instead of submitting (and paying for) a new one.
 * A wrapping fetch captures the `X-Fal-Billable-Units` response header when fal sends it.
 */
export const falSdkOverrides: { fetch?: FetchLike; pollIntervalMs?: number } = {};

export interface FalRunHandle {
  client: FalClient;
  billableUnits: Map<string, number>;
}

export function falClient(key: string): FalRunHandle {
  const billableUnits = new Map<string, number>();
  const base = falSdkOverrides.fetch ?? fetch;
  const capturing = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await base(String(input instanceof Request ? input.url : input), init);
    const units = res.headers.get('x-fal-billable-units');
    const m = String(input instanceof Request ? input.url : input).match(/\/requests\/([^/?]+)/);
    if (units && m && !Number.isNaN(Number(units))) billableUnits.set(m[1], Number(units));
    return res;
  }) as typeof fetch;
  const client = createFalClient({ credentials: key, fetch: capturing, suppressLocalCredentialsWarning: true, retry: { maxRetries: 0 } });
  return { client, billableUnits };
}

export function mapFalError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof ValidationError) {
    const fields = e.fieldErrors.slice(0, 5).map((f) => `${(f.loc ?? []).join('.')}: ${f.msg}`).join('; ');
    return new ProviderError(`fal rejected the input: ${fields || e.message}`, 'fal', false, 422);
  }
  if (e instanceof ApiError) {
    const retryable = e.status === 408 || e.status === 429 || e.status >= 500;
    const detail = typeof e.body === 'object' && e.body && 'detail' in (e.body as object) ? JSON.stringify((e.body as { detail: unknown }).detail).slice(0, 300) : e.message;
    return new ProviderError(`fal HTTP ${e.status}: ${detail}`, 'fal', retryable && !e.isUserTimeout, e.status);
  }
  const err = e as Error;
  if (err?.name === 'AbortError') return new ProviderError('fal request aborted (timeout or cancellation)', 'fal', false);
  return new ProviderError(`fal network error: ${err?.message ?? String(e)}`, 'fal', true);
}

export async function falSubmit(h: FalRunHandle, endpointId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  try {
    const r = await h.client.queue.submit(endpointId, { input, abortSignal: signal });
    return r.request_id;
  } catch (e) {
    throw mapFalError(e);
  }
}

export async function falWait(h: FalRunHandle, endpointId: string, requestId: string, timeoutMs: number, signal?: AbortSignal) {
  try {
    await h.client.queue.subscribeToStatus(endpointId, { requestId, mode: 'polling', pollInterval: falSdkOverrides.pollIntervalMs ?? 1500, timeout: timeoutMs, abortSignal: signal });
    const r = await h.client.queue.result(endpointId, { requestId, abortSignal: signal });
    return { data: r.data as Record<string, unknown>, requestId: r.requestId, billableUnits: h.billableUnits.get(requestId) ?? null };
  } catch (e) {
    throw mapFalError(e);
  }
}

export async function falCancel(h: FalRunHandle, endpointId: string, requestId: string) {
  try {
    await h.client.queue.cancel(endpointId, { requestId });
  } catch {
    /* best effort: the request may already be running or complete */
  }
}
