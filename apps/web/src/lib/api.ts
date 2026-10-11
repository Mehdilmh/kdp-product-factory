/** Thin fetch wrapper: same-origin cookies, CSRF header on mutations, typed errors. No secrets in the browser. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, isForm = false): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers['x-requested-with'] = 'kdp-factory';
  if (body !== undefined && !isForm) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const e = (data as { error?: { code: string; message: string; details?: unknown } })?.error;
    const detail = e?.details as { path: string; message: string }[] | undefined;
    const extra = Array.isArray(detail) && detail[0]?.message ? ` — ${detail.slice(0, 3).map((d) => (d.path ? `${d.path}: ` : '') + d.message).join('; ')}` : '';
    throw new ApiError(res.status, e?.code ?? 'HTTP_' + res.status, (e?.message ?? res.statusText) + extra, e?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  put: <T>(p: string, b: unknown) => request<T>('PUT', p, b),
  patch: <T>(p: string, b: unknown) => request<T>('PATCH', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
  upload: <T>(p: string, form: FormData) => request<T>('POST', p, form, true),
};
