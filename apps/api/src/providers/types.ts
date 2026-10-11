export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TextRequest {
  system: string;
  prompt: string;
  /** Ask the provider for a JSON object response. */
  json: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Structured task description. Real providers ignore it; the mock provider uses it. */
  task?: { name: string; input: unknown };
}
export interface TextResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}
export interface ImageRequest {
  prompt: string;
  widthPx: number;
  heightPx: number;
  signal?: AbortSignal;
  seed?: string;
}
export interface ImageResult {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
  model: string;
}

export interface TextProvider {
  readonly id: string;
  readonly model: string;
  generate(req: TextRequest): Promise<TextResult>;
}
export interface ImageProvider {
  readonly id: string;
  readonly model: string;
  generate(req: ImageRequest): Promise<ImageResult>;
}

/** Normalised provider failure. `retryable` drives the retry policy. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export async function providerFetch(fetchImpl: FetchLike, provider: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ProviderError(`${provider} request aborted (timeout or cancellation)`, provider, false);
    throw new ProviderError(`${provider} network error: ${(e as Error).message}`, provider, true);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    // 408/429/5xx are transient; other 4xx (bad key, bad request, policy refusal) are not.
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    throw new ProviderError(`${provider} HTTP ${res.status}: ${body.replace(/key=[^&\s"]+/gi, 'key=***')}`, provider, retryable, res.status);
  }
  return res;
}

export interface Pricing {
  inputPer1MTokensUsd: number;
  outputPer1MTokensUsd: number;
  perImageUsd: number;
  /** Shown in the UI: prices are estimates configured by the user. */
  note?: string;
}

export const DEFAULT_PRICING: Record<string, Pricing> = {
  mock: { inputPer1MTokensUsd: 0, outputPer1MTokensUsd: 0, perImageUsd: 0, note: 'Mock provider — no cost.' },
  gemini: { inputPer1MTokensUsd: 0.3, outputPer1MTokensUsd: 2.5, perImageUsd: 0, note: 'Estimate. Verify current pricing with Google.' },
  'openai-compatible': { inputPer1MTokensUsd: 0.4, outputPer1MTokensUsd: 1.6, perImageUsd: 0, note: 'Estimate. Verify with your provider.' },
  fal: { inputPer1MTokensUsd: 0, outputPer1MTokensUsd: 0, perImageUsd: 0.003, note: 'Estimate. Verify current fal.ai pricing for the model.' },
  'mock-image': { inputPer1MTokensUsd: 0, outputPer1MTokensUsd: 0, perImageUsd: 0, note: 'Mock provider — no cost.' },
};

export const estimateCost = (p: Pricing, u: { inputTokens?: number; outputTokens?: number; images?: number }) =>
  ((u.inputTokens ?? 0) * p.inputPer1MTokensUsd) / 1e6 + ((u.outputTokens ?? 0) * p.outputPer1MTokensUsd) / 1e6 + (u.images ?? 0) * p.perImageUsd;
