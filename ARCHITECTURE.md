# KDP Product Factory — Architecture

## 1. Shape of the system

```
./                                 npm workspaces monorepo (Node ≥ 20)
├── packages/core   @kdp/core      Deterministic publishing engine (pure TypeScript, no I/O except bundled fonts)
├── apps/api        @kdp/api       Express REST API + BullMQ worker + Prisma/PostgreSQL + storage + AI providers
└── apps/web        @kdp/web       React + Vite + Tailwind single-page app (shadcn-style components)
```

```
 Browser (React SPA) ──HTTPS, session cookie, X-Requested-With──▶ Express API ──▶ PostgreSQL (Prisma)
        ▲   print-size SVG previews / downloads                      │   │
        │                                                            │   └──▶ Object storage (local FS or S3)
        └────────────────────────────── job status polling ◀─────────┤
                                                                     └──▶ Redis (BullMQ) ──▶ Worker process
                                                                                              │
                                    @kdp/core (layout, PDF, cover, preflight, exports) ◀──────┤
                                    AI providers (Gemini / OpenAI-compatible / fal.ai / mock) ◀┘
```

`@kdp/core` is imported by both the API (full engine) and the web app (browser-safe subset via
`@kdp/core/browser`: schemas, specs, geometry, metadata checks). The same Zod schemas validate
data at the API boundary and in the editors.

## 2. Deterministic core (`packages/core`)

| Module | Responsibility |
|---|---|
| `specs/` | Versioned KDP **specification library** (`kdp-2026.10.1`) and the `SpecSource` adapter. Every value carries a `Verification` (`CORROBORATED`, `UNVERIFIED`, `OFFICIAL_TEMPLATE`), a source URL, and a last-verified date. `resolvePrintSpec()` gives page size, bleed, minimum margins (gutter by page count), and page-count limits. |
| `cover/geometry.ts` | Paperback full-wrap geometry (bleed + back + spine + front + bleed; spine = pages × per-page thickness by ink/paper). Hardcover geometry is **never** derived from paperback formulas — it requires official calculator/template values. eBook front cover canvas. Barcode area, safe zones, hinges, RTL mirroring. |
| `interior/schema.ts` | Typed interior model: page instances, 13 element types (heading, text, lines, dotGrid, grid, checklist, table, fields, box, image, spacer, divider, columns), templates with `{{field}}` placeholders, long-form chapters with flow blocks and endnotes. No HTML or code from AI or users. |
| `interior/templates.ts` | 21 built-in templates (daily/weekly planner, work-order log, inspection log, meeting notes, habit/budget trackers, reading log, lined/guided journal, workbook exercise, chapter opener, dot/graph grid, title/copyright/TOC/how-to/belongs-to, notes, about-the-author). |
| `interior/layout.ts` | Deterministic layout engine: page frames (recto/verso gutter alternation, bleed on the outside edge only), vertical stacking with auto/fixed/fill heights, text wrapping from real font metrics, tables that stretch or fill, page numbers and running headers inside the live area, long-form flow with orphan/widow control, recto chapter starts, generated TOC, and endnotes. It iterates until the gutter tier matches the final page count. Every op is bounds-checked against the live area. Overflow, clipping, missing glyphs, low DPI, thin lines and colour-in-B&W are reported as structured warnings. |
| `pdf/` | `renderInteriorPdf` / `renderCoverPdf` with pdf-lib: fully embedded TrueType fonts (Carlito/Caladea, OFL), TrimBox/BleedBox, real PDF axial shadings for gradients, grayscale conversion for B&W interiors, fixed metadata dates → **byte-identical output**. `inspectPdf` verifies boxes, font embedding, encryption, JavaScript, annotations, images of *any* PDF. |
| `cover/layout.ts`, `cover/svg.ts` | Panel-anchored layers (front/back/spine/canvas), so a spine-width change never moves front-cover art. Shared layout → editable SVG (live `<text>`, optional embedded fonts, guides) and PDF. Safe-zone, spine-eligibility, barcode-area, bleed-gap, DPI and placeholder checks. |
| `validation/` | Versioned **rules registry** (`rules-2026.10.1`, 40+ rules). Each result has rule id+version, severity, status (PASS / WARNING / FAIL / NEEDS_HUMAN_REVIEW / NOT_APPLICABLE), evidence, suggested correction, applicable formats, rule source, source verification and last-verified date. Only technical rules can be `blocking`. A crashing rule reports NEEDS_HUMAN_REVIEW, never PASS. |
| `similarity/` | Shingling, MinHash signatures, title similarity with light stemming — portfolio duplicate detection that flags for review only. |
| `metadata/` | Metadata schema, keyword evidence records, deterministic checks (length limits, promotional terms, keyword stuffing, claims, HTML, ISBN checksum). |
| `export/` | EPUB 3 builder + structural inspector, DOCX manuscript, metadata CSV/JSON (formula-injection safe), keyword research CSV, SHA-256 manifest. |
| `pipeline.ts` | `runPipeline()`: layout → interior PDF → inspect → cover geometry from the **final** page count → cover PDF/SVG (or eBook PNG) → EPUB → preflight. Used by the worker, the exports, and the fixture tests. |
| `fixtures.ts` | Five fixture projects (6×9 journal, 8.5×11 workbook, 6×9 hardcover, reflowable eBook, bleed-enabled illustrated paperback). |

## 3. API (`apps/api`)

* **Express + Zod + OpenAPI.** Every endpoint is declared once with `defineRoute()`. That one
  definition validates params, query and body with Zod, enforces auth and minimum role, and
  registers the OpenAPI path. The docs are served at `/api/docs` (Swagger UI) and
  `/api/openapi.json`.
* **Auth.** Email + password (scrypt N=2¹⁵), server-side sessions (random 256-bit token; only its
  SHA-256 is stored), `httpOnly` `SameSite=Lax` cookie (`Secure` in production), sliding
  expiry, and session revocation on password change. A CSRF guard requires
  `X-Requested-With: kdp-factory` on state-changing requests. Rate limits apply globally and are
  stricter on credential endpoints.
* **Tenancy.** Users ↔ workspaces through `Membership(role OWNER|ADMIN|EDITOR|VIEWER)`. Every
  query is scoped by the session's active workspace (`getProject(workspaceId, id)` and
  `findFirst({ where: { id, workspaceId } })`). Cross-workspace access returns 404.
* **Storage.** `StorageAdapter` with `LocalStorage` (dev) and `S3Storage`
  (S3/MinIO/R2-compatible). Keys are server-generated, and traversal and absolute paths are
  rejected. Downloads go through workspace-checked routes only.
* **Uploads.** multer memory storage with a size limit. The type is detected from content
  (PNG/JPEG headers, `%PDF-`). SVG/HTML are rejected, as are encrypted PDFs and PDFs with
  JavaScript. A license note is recorded per asset.
* **Providers** (`src/providers`). `TextProvider` / `ImageProvider` interfaces with Gemini,
  OpenAI-compatible, fal.ai and deterministic mock implementations. The gateway adds quota
  checks (daily/monthly cost, daily jobs), a per-config rate limit, retries with exponential
  backoff (retryable = network/408/429/5xx), timeouts, and usage records with estimated cost.
  API keys are AES-256-GCM encrypted at rest and never returned.
* **Generation** (`services/generation.ts`). Prompts demand JSON. Responses are Zod-validated
  with one repair round. Page plans may only use built-in template ids. Locked pages are never
  overwritten. Cover art is generated as background art only, and titles, author and spine text
  stay live text. Suggestions only fill empty metadata fields and are labelled "AI suggestion
  (unverified)".
* **Jobs.** `GenerationJob` rows hold the status, stage, progress, attempts, logs and stage
  results. `processJob()` is a resumable stage machine: completed stages are skipped on retry,
  cancellation is honoured at stage boundaries, and every stage has a timeout. Two runners
  exist: `BullMQRunner` (production; separate `worker.ts`, exponential backoff,
  `UnrecoverableError` for permanent failures) and `InlineRunner` (tests and single-process
  development), with the same retry semantics.
* **Exports.** Final print/EPUB files are refused when (a) the preflight has blocking failures,
  (b) NEEDS_HUMAN_REVIEW items are unreviewed, or (c) a batch item is not approved. Editable
  exports are always allowed. Each bundle stores the artifacts, `manifest.json` (filenames,
  SHA-256, spec version, ruleset version, page count, trim, validation status) and a bundle
  zip.
* **Versioning.** `ProjectVersion` snapshots the brief, format, interior, covers and metadata.
  Restoring first snapshots the current state, so a restore can itself be undone. Versions are
  taken automatically on creation and before AI generation.
* **Batch.** CSV/JSON import (≤500 rows per import, row-level errors). A differentiation check
  compares each item with the earlier rows and the portfolio: near-identical briefs become
  `DUPLICATE` and are never generated. Concurrency-limited pumping supports pause, resume and
  cancel. Each item must be manually approved with a six-point quality checklist before final
  export.
* **Audit.** `AuditLog` covers sign-ins, project/template/provider changes, reviews, exports and
  downloads. Secrets are never logged.

## 4. Web app (`apps/web`)

React 18 + Vite + TypeScript + Tailwind. It uses shadcn-style components built on Radix,
TanStack Query for server state (polling only while jobs are active), zustand for cover-editor
history (undo/redo), and React Hook Form + Zod for the wizard. Light and dark themes are built
from CSS variable tokens. Routes are lazy-loaded.

* **Interior editor.** Uses server-rendered print-size SVG previews produced by the *same* layout
  engine as the PDF, so the preview matches print. It supports page operations, template
  fields, a typed element editor (form or validated JSON), document settings, per-page issue
  lists, and a chapter editor for long-form books.
* **Cover editor.** The server-rendered SVG gives exact typography and guides, with an
  interactive overlay for selection, dragging, resizing and keyboard nudging. It has layers and
  properties panels, gradients, icons, image upload with license notes, an official-template
  import, and undo/redo.

## 5. Data model (PostgreSQL)

`User`, `Session`, `Workspace`, `Membership`, `Project`, `ProductBrief`, `ProductFormat`,
`InteriorDocument`, `PageInstance` (stable per-document `key`), `PageTemplate`,
`CoverDesign`, `Asset`, `MetadataDraft`, `ValidationRule` (registry mirror), `ValidationReport`,
`HumanReview`, `GenerationJob`, `BatchJob`, `BatchItem`, `ExportArtifact`, `ProviderConfig`,
`UsageRecord`, `ProjectVersion`, `Preset`, `AuditLog`. Foreign keys cascade from
workspace/project, with indexes on `(workspaceId, status)`, `(workspaceId, createdAt)`, job
lookups and export bundles. Migrations live in `apps/api/prisma/migrations`.

## 6. Key decisions

1. **Fonts.** Only bundled OFL fonts (Carlito, Caladea) are embedded, and **in full** — pdf-lib's
   subsetter dropped glyphs from Carlito during testing. Ligatures are disabled in both
   measurement and embedding so measured widths always match the drawn glyphs.
2. **Determinism.** Fixed PDF dates and creator strings, seeded identifiers, rounded geometry,
   and sorted zip entries with fixed timestamps (EPUB, DOCX, bundles). Tests assert that
   identical input produces identical SHA-256 output.
3. **Specs as data.** Rendering never hardcodes KDP numbers. Unverifiable values are marked
   `UNVERIFIED` and surface as NEEDS_HUMAN_REVIEW. Hardcover cover geometry requires official
   values.
4. **AI never decides pass/fail.** All blocking checks are deterministic. Content-risk checks are
   heuristics that ask for human review.

## 7. Image model library and Coloring Studio

```
packages/core/src/models      pricing.ts (units, estimates, staleness) · capabilities.ts (OpenAPI → capabilities,
                              schema-validated inputs) · seed.ts (unverified candidates, editorial tags)
packages/core/src/coloring    presets, StyleProfile, deterministic prompt builder, repeated concepts,
                              QC thresholds, buildColoringDocument() → InteriorDocument
apps/api/src/providers        fal-platform.ts (catalog / pricing / usage, server-side, retries + timeouts)
                              fal-sdk.ts (@fal-ai/client queue: submit → wait → result, billable-units capture)
apps/api/src/services         image-catalog.ts (seed, sync, prices with history, periodic refresh)
                              image-generation.ts (prepare → confirm → limits → submit/resume → download → asset
                              → usage + actual cost) · image-jobs.ts (IMAGE_GENERATE / MODEL_COMPARE)
                              coloring.ts (books, plan, estimates, COLORING_GENERATE, versions, interior,
                              unified preflight, export files) · coloring-image.ts (sharp QC + processing)
```

Data: `ImageModel`, `ImageModelPrice` (history; `isCurrent`), `ImageGeneration` (settings, estimate,
request id, actual cost, assets), `ModelComparison`, `ProviderUsageReport`, `SystemState`;
`ColoringBook` (1:1 with a `COLORING_BOOK` project), `ColoringStyleProfile`, `ColoringPage`,
`ColoringPageVersion` (original + processed asset, QC, dHash, costs). All rows are workspace-scoped
through their project/workspace; cascades remove them with the project.

Decisions:

- **No invented catalog or prices.** Seeds are candidates until fal's catalog confirms them and
  returns a schema; prices only from fal's pricing API or an admin entry with a source URL.
- **Confirm before paying.** Every paid path checks a user-confirmed amount ≥ the server estimate
  (or an explicit acceptance of an unverified cost) and all budget caps before the provider call.
- **No double charges.** Submit and wait are separate; the provider request id is persisted
  first, so job retries resume the same request. Completed pages/items are skipped on retry.
- **The model never decides print geometry.** Cover art size/aspect come from the verified cover
  geometry; coloring interiors from the spec engine; text stays live.
- **Heuristics are labelled.** QC distinguishes automated facts, heuristic signals and manual
  checks; preflight separates unverified official requirements. Nothing claims KDP approval.
- **A coloring book is a project.** The studio adds planning, generation and QC, then writes the
  project's interior document, so layout, PDF, preflight, covers and exports are shared code.
