import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JOB_RUNNER: z.enum(['bullmq', 'inline']).default('bullmq'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.string().default('true'),
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_BASE_URL: z.string().default('https://api.openai.com/v1'),
  FAL_KEY: z.string().optional(),
  /** Admin-scope fal key — only needed for provider-reported usage/cost (fal usage API). */
  FAL_ADMIN_KEY: z.string().optional(),
  FAL_PLATFORM_API_URL: z.string().default('https://api.fal.ai/v1'),
  /** Comma-separated emails that manage the global model catalog. */
  PLATFORM_ADMIN_EMAILS: z.string().default(''),
  CATALOG_REFRESH_HOURS: z.coerce.number().min(0).default(24),
  IMAGE_DOWNLOAD_MAX_MB: z.coerce.number().default(60),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_TTL_DAYS: z.coerce.number().default(14),
  MAX_UPLOAD_MB: z.coerce.number().default(25),
});
export type AppConfig = z.infer<typeof Env>;

let cached: AppConfig | null = null;
export function loadConfig(overrides: Partial<Record<keyof AppConfig, unknown>> = {}): AppConfig {
  const raw = { ...process.env, ...overrides };
  // Empty strings in .env mean "unset".
  for (const k of Object.keys(raw)) if (raw[k as keyof typeof raw] === '') delete raw[k as keyof typeof raw];
  const parsed = Env.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Invalid configuration: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  cached = parsed.data;
  return cached;
}
export function config(): AppConfig {
  return cached ?? loadConfig();
}
