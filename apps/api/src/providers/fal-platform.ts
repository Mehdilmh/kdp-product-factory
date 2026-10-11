import { config } from '../config';
import { withRetry, withTimeout } from './retry';
import { providerFetch, ProviderError, type FetchLike } from './types';

/**
 * Client for fal's documented Platform APIs (https://api.fal.ai/v1):
 *   GET  /models            — catalog (list / find by endpoint_id / search by q, category, status), expand=openapi-3.0
 *   GET  /models/pricing    — unit_price, unit, currency per endpoint_id
 *   GET  /models/usage      — billed usage (Admin-scope key)
 * Responses are parsed defensively; unexpected shapes raise errors instead of being guessed.
 */
export const falPlatform = { fetch: fetch as FetchLike };

export interface FalCatalogModel {
  endpoint_id: string;
  metadata?: {
    display_name?: string;
    category?: string;
    description?: string;
    status?: string;
    tags?: string[];
    updated_at?: string;
    thumbnail_url?: string;
    model_url?: string;
    license_type?: string;
    [k: string]: unknown;
  };
  openapi?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface FalPrice {
  endpoint_id: string;
  unit_price: number;
  unit: string;
  currency: string;
}

async function call<T>(path: string, query: [string, string][], opts: { key?: string | null; signal?: AbortSignal } = {}): Promise<T> {
  const url = `${config().FAL_PLATFORM_API_URL.replace(/\/$/, '')}${path}${query.length ? '?' + new URLSearchParams(query).toString() : ''}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  const key = opts.key === undefined ? config().FAL_KEY : opts.key;
  if (key) headers.authorization = `Key ${key}`;
  return withRetry(
    () =>
      withTimeout(async (signal) => {
        const res = await providerFetch(falPlatform.fetch, 'fal-platform', url, { headers, signal });
        return (await res.json()) as T;
      }, 30_000, 'fal platform API', opts.signal),
    { attempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 },
  );
}

function assertPage(data: unknown, field: string): { items: unknown[]; next: string | null } {
  const d = data as Record<string, unknown>;
  if (!d || !Array.isArray(d[field])) throw new ProviderError(`Unexpected fal response: missing "${field}" array`, 'fal-platform', false);
  return { items: d[field] as unknown[], next: (d.next_cursor as string | null) ?? null };
}

/** Find specific endpoints (max 50 per call) with their OpenAPI schemas. */
export async function falFindModels(endpointIds: string[], expandOpenApi = true): Promise<FalCatalogModel[]> {
  const out: FalCatalogModel[] = [];
  for (let i = 0; i < endpointIds.length; i += 50) {
    const q: [string, string][] = endpointIds.slice(i, i + 50).map((id) => ['endpoint_id', id]);
    if (expandOpenApi) q.push(['expand', 'openapi-3.0']);
    const page = assertPage(await call(`/models`, q), 'models');
    out.push(...(page.items as FalCatalogModel[]));
  }
  return out;
}

/** Search the catalog by category (paginated). */
export async function falSearchModels(opts: { category?: string; q?: string; status?: string; maxPages?: number; expandOpenApi?: boolean }): Promise<FalCatalogModel[]> {
  const out: FalCatalogModel[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < (opts.maxPages ?? 20); page++) {
    const q: [string, string][] = [['limit', '50']];
    if (opts.category) q.push(['category', opts.category]);
    if (opts.q) q.push(['q', opts.q]);
    if (opts.status) q.push(['status', opts.status]);
    if (opts.expandOpenApi) q.push(['expand', 'openapi-3.0']);
    if (cursor) q.push(['cursor', cursor]);
    const p = assertPage(await call(`/models`, q), 'models');
    out.push(...(p.items as FalCatalogModel[]));
    if (!p.next) break;
    cursor = p.next;
  }
  return out;
}

export async function falPricing(endpointIds: string[]): Promise<FalPrice[]> {
  if (!config().FAL_KEY) throw new ProviderError('FAL_KEY is required to read fal pricing.', 'fal-platform', false);
  const out: FalPrice[] = [];
  for (let i = 0; i < endpointIds.length; i += 50) {
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const q: [string, string][] = endpointIds.slice(i, i + 50).map((id) => ['endpoint_id', id]);
      if (cursor) q.push(['cursor', cursor]);
      const p = assertPage(await call(`/models/pricing`, q), 'prices');
      for (const raw of p.items as Record<string, unknown>[]) {
        if (typeof raw.endpoint_id !== 'string' || typeof raw.unit_price !== 'number' || typeof raw.unit !== 'string') continue;
        out.push({ endpoint_id: raw.endpoint_id, unit_price: raw.unit_price, unit: raw.unit, currency: typeof raw.currency === 'string' ? raw.currency : 'USD' });
      }
      if (!p.next) break;
      cursor = p.next;
    }
  }
  return out;
}

export interface FalUsageLine {
  endpointId: string;
  periodStart: string;
  periodEnd: string;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  costTotal: number | null;
  currency: string;
  raw: unknown;
}

/** Provider-reported usage (Admin key). Parses `time_series[].results[]` buckets defensively. */
export async function falUsage(startIso: string, endIso: string): Promise<FalUsageLine[]> {
  const key = config().FAL_ADMIN_KEY;
  if (!key) throw new ProviderError('FAL_ADMIN_KEY (Admin scope) is required for provider-reported usage.', 'fal-platform', false);
  const out: FalUsageLine[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const q: [string, string][] = [['start', startIso], ['end', endIso], ['expand', 'time_series']];
    if (cursor) q.push(['cursor', cursor]);
    const data = (await call<Record<string, unknown>>(`/models/usage`, q, { key })) ?? {};
    const buckets = (data.time_series as Record<string, unknown>[] | undefined) ?? [];
    for (const b of buckets) {
      const start = String(b.bucket ?? b.start ?? startIso);
      for (const r of (b.results as Record<string, unknown>[] | undefined) ?? []) {
        out.push({
          endpointId: String(r.endpoint_id ?? 'unknown'),
          periodStart: start,
          periodEnd: String(b.end ?? endIso),
          quantity: typeof r.quantity === 'number' ? r.quantity : null,
          unit: typeof r.unit === 'string' ? r.unit : null,
          unitPrice: typeof r.unit_price === 'number' ? r.unit_price : null,
          costTotal: typeof r.cost_total === 'number' ? r.cost_total : typeof r.cost === 'number' ? r.cost : null,
          currency: typeof r.currency === 'string' ? r.currency : 'USD',
          raw: r,
        });
      }
    }
    cursor = (data.next_cursor as string | null) ?? null;
    if (!cursor) break;
  }
  return out;
}
