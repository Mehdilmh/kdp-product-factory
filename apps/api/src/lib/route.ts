import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import type { Role } from '@prisma/client';
import type { Request, Response, Router } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { requireUser, requireWorkspace, type AuthContext } from './auth';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();
registry.registerComponent('securitySchemes', 'cookieAuth', { type: 'apiKey', in: 'cookie', name: 'kdp_session' });

export const ErrorSchema = registry.register(
  'Error',
  z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) }),
);

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteDef<B extends ZodTypeAny, Q extends ZodTypeAny, P extends ZodTypeAny> {
  method: Method;
  path: string;
  summary: string;
  tag: string;
  /** "public" = no auth, "user" = signed in, "workspace" = signed in with active workspace (default). */
  auth?: 'public' | 'user' | 'workspace';
  /** Minimum workspace role; defaults to VIEWER for GET and EDITOR otherwise. */
  minRole?: Role;
  body?: B;
  query?: Q;
  params?: P;
  response?: ZodTypeAny;
  status?: number;
  /** Handler writes the response itself (files, streams). */
  raw?: boolean;
  responseContentType?: string;
}

export interface Ctx<B, Q, P> {
  req: Request;
  res: Response;
  body: B;
  query: Q;
  params: P;
  auth: AuthContext;
  ws: AuthContext & { workspaceId: string; role: Role };
}

const asyncWrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: (e?: unknown) => void) => fn(req, res).catch(next);

/**
 * Registers an Express handler and its OpenAPI description from one definition, with Zod
 * validation of params, query, and body at the API boundary.
 */
export function defineRoute<B extends ZodTypeAny = z.ZodUndefined, Q extends ZodTypeAny = z.ZodUndefined, P extends ZodTypeAny = z.ZodUndefined>(
  router: Router,
  def: RouteDef<B, Q, P>,
  handler: (ctx: Ctx<z.infer<B>, z.infer<Q>, z.infer<P>>) => Promise<unknown>,
) {
  const auth = def.auth ?? 'workspace';
  const minRole = def.minRole ?? (def.method === 'get' ? 'VIEWER' : 'EDITOR');
  router[def.method](
    def.path,
    asyncWrap(async (req, res) => {
      let a: AuthContext | undefined;
      let ws: (AuthContext & { workspaceId: string; role: Role }) | undefined;
      if (auth === 'user') a = requireUser(req);
      if (auth === 'workspace') a = ws = requireWorkspace(req, minRole);
      const params = def.params ? def.params.parse(req.params) : undefined;
      const query = def.query ? def.query.parse(req.query) : undefined;
      const body = def.body ? def.body.parse(req.body) : undefined;
      const result = await handler({ req, res, body, query, params, auth: a!, ws: ws! });
      if (def.raw) return;
      res.status(def.status ?? 200).json(result ?? { ok: true });
    }),
  );
  const openapiPath = '/api' + def.path.replace(/:([a-zA-Z]+)/g, '{$1}');
  registry.registerPath({
    method: def.method,
    path: openapiPath,
    summary: def.summary,
    tags: [def.tag],
    security: auth === 'public' ? [] : [{ cookieAuth: [] }],
    request: {
      params: def.params as never,
      query: def.query as never,
      body: def.body ? { content: { 'application/json': { schema: def.body } } } : undefined,
    },
    responses: {
      [def.status ?? 200]: def.responseContentType
        ? { description: 'File', content: { [def.responseContentType]: { schema: { type: 'string', format: 'binary' } } } }
        : { description: 'Success', content: def.response ? { 'application/json': { schema: def.response } } : undefined },
      400: { description: 'Validation error', content: { 'application/json': { schema: ErrorSchema } } },
      401: { description: 'Not signed in', content: { 'application/json': { schema: ErrorSchema } } },
      403: { description: 'Forbidden', content: { 'application/json': { schema: ErrorSchema } } },
      404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
    },
  });
}

export const IdParams = z.object({ id: z.string().min(1).max(64) });

/** Query-string boolean: only "true"/"1" are true (z.coerce.boolean() would turn "false" into true). */
export const queryBool = (def: boolean) => z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).default(def).transform((v) => v === true || v === 'true' || v === '1');
