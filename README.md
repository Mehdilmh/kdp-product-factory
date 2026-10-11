# KDP Product Factory

A web application for planning, producing, validating, and exporting **original** Amazon KDP
products: journals, notebooks, planners, logbooks, trackers, workbooks, activity, educational,
nonfiction, illustrated and **coloring** books, in paperback, hardcover, and Kindle eBook formats.
It includes an **image model library** (fal.ai catalog with live pricing) and a **Coloring Book
Studio** (plan → generate → QC → review → interior → cover → preflight → export).

The core is a deterministic publishing engine. It handles print geometry, layout, embedded-font
PDFs, cover geometry, and preflight checks. AI providers draft concepts, content, metadata, and
cover art, and everything they draft stays editable. A human reviews every product before
final export.

> **No guarantees.** Validation reduces risk; it does **not** guarantee KDP acceptance, sales,
> or policy compliance. KDP requirements change. The specification library records the source
> and verification status of every value; check the current KDP help pages and the official
> cover calculator before publishing.

See [PLAN.md](PLAN.md), [ARCHITECTURE.md](ARCHITECTURE.md), and [TASKS.md](TASKS.md).

---

## Quick start (local development)

Requirements: Node.js ≥ 20, PostgreSQL ≥ 14, Redis ≥ 6 (Redis is optional with `JOB_RUNNER=inline`).

```bash
npm install                                   # installs all workspaces, generates the Prisma client

# Services: either your own Postgres/Redis or Docker
docker compose up -d                          # postgres:16 + redis:7 (see docker-compose.yml)

cp apps/api/.env.example apps/api/.env        # then set DATABASE_URL and a random APP_SECRET (≥ 32 chars)
npm run db:migrate                            # prisma migrate deploy
npm run db:seed                               # demo account + the 5 fixture projects

# Three terminals:
npm run dev:api                               # API on http://localhost:4000 (docs: /api/docs)
npm run dev:worker                            # BullMQ worker (generation, validation, exports)
npm run dev:web                               # web app on http://localhost:5173 (proxies /api)
```

Sign in with **demo@kdp-factory.local / demo-password-123**, or register a new account.

**Single-process mode** (no Redis, no worker): set `JOB_RUNNER=inline` in `apps/api/.env` and
skip `dev:worker`. Jobs then run inside the API process with the same retry and cancel semantics.

**Production-style single origin:** `npm run build -w @kdp/web && npm run start -w @kdp/api`
serves the built SPA and the API from port 4000.

### AI providers

Without configuration, deterministic **mock** providers are used. They cost nothing and produce
generic output that is clearly marked as AI-generated in the project. To use real providers,
open **Settings → Providers** (keys are encrypted at rest and never shown again) or set server
environment variables:

| Kind | Provider | Env var | Notes |
|---|---|---|---|
| Text | Google Gemini | `GEMINI_API_KEY` | Model configurable (default `gemini-2.5-flash`). |
| Text | OpenAI-compatible | `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL` | Any `/chat/completions` endpoint. |
| Image | fal.ai | `FAL_KEY` | Model library, cover art, coloring pages. Text on covers stays live text. |

Text-provider pricing for cost estimates is configured per provider. Estimates are not invoices.

### Image model library (fal.ai) and pricing

**What fal.ai officially exposes** (investigated before building; used through server-side
calls only):

| Data | Official source | Notes |
|---|---|---|
| Model catalog | Platform API `GET https://api.fal.ai/v1/models` (`endpoint_id` lookup ≤ 50 per call, `category`/`q`/`status` search, cursor pagination, `expand=openapi-3.0`) | Gives display name, category, status and each endpoint's **OpenAPI input/output schema**, from which capabilities are derived (sizes, aspect ratios, resolutions, negative prompt, reference images, masks, seeds…). |
| Prices | `GET /v1/models/pricing?endpoint_id=…` (needs `Authorization: Key …`) | `unit_price`, `unit`, `currency` per endpoint. Units vary (image, megapixel, tokens, seconds…); they are normalised and **never relabelled** (per-megapixel stays per-megapixel). |
| Actual usage/cost | `GET /v1/models/usage` (needs an **Admin**-scope key, `FAL_ADMIN_KEY`) and the `X-Fal-Billable-Units` response header | Per-request actual cost is computed only when fal reports billable units; otherwise it is shown as "not reported". |
| Generation | Official `@fal-ai/client` SDK queue API (`submit` → status → `result`) | Request id is stored before waiting, so retries resume instead of paying again. |

There is no public "sample image" field guaranteed by the API; cards show `thumbnail_url` only
when the catalog provides it.

**How it behaves**

- Seed models (Nano Banana 2/Pro, FLUX.1 schnell/dev, FLUX.2 variants, Seedream 4.5, Recraft V3,
  GPT Image 2, Ideogram V3, edit/upscale models…) start as **"Candidate — not verified"**,
  disabled, with **no price**. A catalog sync (Image models → *Sync catalog & prices*, platform
  admins only; also automatic every `CATALOG_REFRESH_HOURS` when `FAL_KEY` is set) verifies each
  endpoint and stores its schema. Endpoints not found are marked *Not found* and stay disabled.
- Prices come only from fal's pricing API or an admin-recorded price **with an https source URL**
  (history kept). Without one the UI shows **"Price unavailable"** and generation requires an
  explicit "I accept an unverified cost" confirmation. Token-priced models need a
  tokens-per-image assumption before they can be estimated.
- Every generation (single, comparison, cover art, coloring batch) shows the estimate first and
  the server rejects requests whose confirmed amount does not cover it. Workspace (daily/monthly),
  project, per-member and per-book budget caps are enforced before each provider call.
- Settings are validated against the model's own schema; unsupported options are rejected, not
  silently dropped.
- Two **offline mock** models (`mock/line-art`, `mock/cover-art`) draw procedural shapes for $0.
  They are labelled "Not AI" everywhere and exist so the workflow can be tested without a key.

**Platform admins** are users listed in `PLATFORM_ADMIN_EMAILS` (or with `isPlatformAdmin`).
Only they can sync the catalog, enable models, edit tags/limitations/commercial-use links and
record prices.

### Coloring Book Studio

*Coloring Studio* in the sidebar. A coloring book is a normal project (category `COLORING_BOOK`),
so the interior editor, cover designer, metadata editor, preflight and export center all apply.

1. **Create**: audience preset (Toddlers → Seniors), theme preset, description, age range,
   difficulty, illustration count, series, trim (8.5×11, 8×10, 8.5×8.5, 8.25×8.25, A4, …),
   single-sided printing, default model and budget cap.
2. **Art direction**: style, outline thickness, detail, complexity, subject size, white space,
   number of subjects, background, composition, aspect, extra direction; saved as a reusable
   style profile. Prompts are built deterministically from it (black outlines on white, no
   shading, no text…); hand-edited prompts are never overwritten.
3. **Plan**: concepts from the theme or typed; similar concepts are flagged.
4. **Generate**: select pages → model → per-page and total estimate (1/4/10/50/100 table) →
   confirm → background job. Modes: new, variation, edit (image-to-image). Finished pages are kept
   if later ones fail; retries resume the same provider request.
5. **Review**: original and processed image side by side, version history with restore,
   approve/reject/favorite/duplicate/replace/re-process, bulk actions. QC per image:
   *automated* (decode, DPI at placed size, aspect, alpha), *heuristic* (white background, color
   pixels, gray shading, contrast, ink coverage, line weight, cropping, empty areas, perceptual-hash
   near-duplicates) and *manual* (text/watermarks, drawing quality, originality — never
   auto-passed). Failed checks need an override note to approve; overrides are recorded.
   Processing (flatten, grayscale, normalise, denoise, threshold, trim, pad-to-aspect, Lanczos
   resample to 300 DPI) writes a new asset; originals are never modified.
6. **Interior**: built from approved pages in order, with blank reverses in single-sided mode,
   title/copyright/"belongs to"/test pages, scale and alignment. Page count is computed by the
   layout engine; illustrations ≠ pages.
7. **Cover**: the project cover designer (full-wrap geometry from the real page count) with the
   *AI art* dialog for background art.
8. **Preflight**: automated checks, visual (heuristic) warnings, manual review items, and official
   requirements that need verification, shown separately. It is not an approval.
9. **Metadata**: project metadata editor + back-cover copy and a coloring-specific checklist.
10. **Export**: interior PDF, cover PDF, editable cover SVG, proof PDF, approved page images
    (original + print), prompt/generation log CSV, QC report (JSON + HTML), preflight report,
    metadata and a checksummed manifest. Final PDFs remain gated by preflight and reviews.

---

## Tests

```bash
npm run test:core        # 99 unit/integration tests: specs, margins/bleed, spine, cover geometry, layout,
                         # PDF validity + determinism, font embedding, metadata, similarity, rules, EPUB/DOCX,
                         # manifest, five fixture projects, pricing/estimates, OpenAPI capability derivation,
                         # coloring prompts, repeated concepts, coloring interior (single/double-sided)
npm run test:api         # 55 API tests: auth/sessions, isolation, roles, encrypted keys, uploads, providers,
                         # job retries (inline + BullMQ/Redis), quotas, editors, covers, export gating,
                         # batch, end-to-end workflow, fal catalog/pricing sync + queue flow (simulated HTTP),
                         # confirmation/budgets, comparisons, cover art, coloring QC/processing/full workflow
npm run test             # both

# Browser end-to-end (Playwright, Chromium). Needs Postgres + a built web app:
npm run build -w @kdp/web
npm run test:e2e         # 2 specs (product workflow, Coloring Studio); starts the API with JOB_RUNNER=inline
```

API tests use a separate database (`TEST_DATABASE_URL`, default
`postgresql://postgres:postgres@localhost:5432/kdp_factory_test`), which is reset automatically.
The BullMQ test is skipped if Redis is unreachable.

Generate the fixture outputs (interior/cover PDFs, SVG, EPUB, preflight reports) for manual
inspection:

```bash
npm run fixtures         # → packages/core/fixtures-out/<fixture>/
```

| Fixture | Format | Checks |
|---|---|---|
| `journal` | 100-page 6×9 B&W paperback, cream paper | 6"×9" pages, 0.375" min gutter, spine 0.25" (100 × 0.0025"), spine text allowed |
| `workbook` | 8.5×11 paperback workbook | large trim, TOC from chapter openers, tables, checklists |
| `hardcover` | 6×9 hardcover logbook, 120 pages | cover geometry from official calculator values (example values, flagged as such), hinges, low-content review item |
| `ebook` | reflowable Kindle eBook | EPUB structure, nav, endnotes, 1600×2560 px cover |
| `illustrated` | 8.5×8.5 premium-colour paperback with bleed | 8.625"×8.75" pages, bleed on the outside edge, full-bleed art ≥ 300 DPI |

---

## Configuration reference (`apps/api/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `APP_SECRET` | — | ≥ 32 chars; derives the key that encrypts provider API keys (required) |
| `JOB_RUNNER` | `bullmq` (`serverless` on Vercel) | `bullmq` (Redis + worker), `inline`, or `serverless` (time-sliced, self-continuing) |
| `JOB_SLICE_SECONDS` | `240` | Serverless runner: work per invocation before pausing at a safe point |
| `APP_URL` | | Public URL used for job continuations (detected from requests when unset) |
| `CRON_SECRET` | | Authorizes the daily catalog refresh cron (`/api/internal/cron/catalog`) |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ connection |
| `STORAGE_DRIVER` | `local` (`db`/`s3` on Vercel) | `local`, `s3`, or `db` (PostgreSQL) |
| `STORAGE_LOCAL_DIR` | `./storage` | Local storage root |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | | S3-compatible storage (AWS, MinIO, R2, …) |
| `GEMINI_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`, `FAL_KEY` | | Optional server-level provider keys (`FAL_KEY` also enables catalog/price sync) |
| `FAL_ADMIN_KEY` | | Admin-scope fal key for provider-reported usage/cost (`/v1/models/usage`) |
| `FAL_PLATFORM_API_URL` | `https://api.fal.ai/v1` | fal Platform API base |
| `PLATFORM_ADMIN_EMAILS` | | Comma-separated emails allowed to manage the image model catalog and prices |
| `CATALOG_REFRESH_HOURS` | `24` | Automatic catalog + price refresh interval (0 disables) |
| `IMAGE_DOWNLOAD_MAX_MB` | `60` | Size limit for downloading generated images (https only) |
| `PORT` | `4000` | API port |
| `SESSION_TTL_DAYS` | `14` | Sliding session lifetime |
| `MAX_UPLOAD_MB` | `25` | Upload size limit |
| `WORKER_CONCURRENCY` | `2` | Jobs processed in parallel per worker |

---

## Deploying on Vercel

The repository deploys to Vercel as-is (`vercel.json` + `scripts/vercel-build.mjs`, Build Output
API): the web app is served as static files and one Node.js function serves `/api/*`.

1. **Database.** Create a PostgreSQL database (Vercel → Storage → Neon is the simplest; any
   Postgres works). It provides `DATABASE_URL` (and `DATABASE_URL_UNPOOLED`, which the build uses
   for migrations).
2. **Environment variables** (Project → Settings → Environment Variables), for Production and
   Preview:
   - `DATABASE_URL` — required.
   - `APP_SECRET` — required, 32+ random characters (e.g. `openssl rand -hex 32`). Keep it stable:
     it encrypts stored provider keys.
   - `CRON_SECRET` — any random string; enables the daily catalog/price refresh cron.
   - Optional: `FAL_KEY`, `FAL_ADMIN_KEY`, `PLATFORM_ADMIN_EMAILS`, `GEMINI_API_KEY`, and S3
     settings (see below).
3. **Import** the repository in Vercel (*Add New → Project*). Leave the framework as *Other*; the
   build and install commands come from `vercel.json`. Deploy.
4. The build runs `prisma migrate deploy`, builds the web app and bundles the API. Open the site
   and register the first account.

How it runs on Vercel:

- **Jobs** use the `serverless` runner: a job works for up to `JOB_SLICE_SECONDS` (default 240)
  per invocation, pauses at a safe point (finished stages, images and pages are saved) and a fresh
  invocation continues it. If an invocation is interrupted, the job's lease expires and the next
  status poll from the web app resumes it. Nothing already completed (or paid for) is repeated.
- **Files** go to PostgreSQL by default (`STORAGE_DRIVER=db`), so no extra service is needed. For
  larger catalogs, set `S3_BUCKET` (+ `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
  e.g. Cloudflare R2), which switches the driver to `s3`.
- **Limits to know:** Vercel limits request bodies to 4.5 MB, so uploads larger than that fail
  there (use the self-hosted setup for very large uploads). The function is configured for
  300 s and 2 GB (`FUNCTION_MAX_DURATION`, `FUNCTION_MEMORY_MB` at build time); plans that do not
  allow these values need lower ones. Large exports are generated in background jobs.

## Deployment notes (self-hosted)

* Run the API (`npm run start -w @kdp/api`) behind HTTPS (cookies are `Secure` in production),
  with at least one worker (`npm run worker -w @kdp/api`). Workers scale horizontally.
* Run `npm run db:migrate` on each deploy. Run the API with `NODE_ENV=production`.
* Use S3-compatible storage in production. Local storage is per-machine.
* Provider rate limiting is per process; for many workers, set conservative per-config limits.

### Backup and restore

* **Database:** `pg_dump -Fc "$DATABASE_URL" > kdp-$(date +%F).dump`; restore with
  `pg_restore --clean --if-exists -d "$DATABASE_URL" kdp-YYYY-MM-DD.dump`.
  Schedule daily dumps and keep point-in-time recovery if your host offers it.
* **Objects:** enable bucket versioning and replicate or sync the bucket
  (`aws s3 sync s3://bucket s3://backup-bucket`). For local storage, back up `STORAGE_LOCAL_DIR`.
* **Secrets:** back up `APP_SECRET` separately. Encrypted provider keys cannot be decrypted
  without it (re-enter them if it is lost).
* **Restore test:** restore into a staging database, run `npm run db:migrate`, sign in, open a
  project, and download an export to confirm its checksum matches the manifest.

---

## Repository layout

```
apps/api        Express API, Prisma schema/migrations, jobs, providers (Node 20+)
apps/web        React + Vite web app
packages/core   deterministic engine: specs, layout, PDF/SVG/EPUB, preflight, pricing, coloring
scripts/        vercel-build.mjs (Vercel Build Output)
```

This repository was split out of `Domain-Names`; the unrelated domain-valuation app stayed there.
