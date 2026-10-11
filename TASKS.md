# TASKS

Status legend: ✅ implemented **and** covered by automated tests · 🟢 implemented, verified
manually in the browser (no dedicated automated test) · ⚠️ partial / limitation documented ·
❌ not implemented.

Last full verification run: core **99/99**, API **55/55**, browser E2E **2/2** (Playwright,
Chromium), typecheck clean for all three workspaces, production web build OK.

## Milestone 1 — Foundation

| Task | Status | Evidence |
|---|---|---|
| Inspect repository; non-destructive placement (`kdp-factory/`, DomainPulse untouched) | ✅ | PLAN.md §0 |
| PLAN.md, ARCHITECTURE.md, TASKS.md, README.md | ✅ | this folder |
| Monorepo scaffold (core / api / web workspaces) | ✅ | `npm run typecheck` |
| PostgreSQL + Prisma schema, migration, indexes, FKs, timestamps | ✅ | `apps/api/prisma` |
| Authentication: scrypt hashing, hashed session tokens, httpOnly cookie, CSRF header, logout, password change revokes other sessions | ✅ | `auth-isolation.test.ts` |
| Roles (OWNER/ADMIN/EDITOR/VIEWER) and workspace isolation (404 across workspaces for projects, files, jobs, exports, versions) | ✅ | `auth-isolation.test.ts` |
| Rate limiting (global + credential endpoints), request validation (Zod at every route), error handling | ✅ / 🟢 | route helper; rate limiter configured (not load-tested) |
| Dashboard: pipeline counts, recent products, running jobs, failed jobs, validation attention, spend vs. budget | 🟢 | screenshots reviewed |

## Milestone 2 — Wizard, schemas, deterministic interior

| Task | Status | Evidence |
|---|---|---|
| 4-step wizard (concept, format, content type, generation settings), presets, live spec preview | ✅ | Playwright `workflow.spec.ts` |
| Low / medium / full content classes drive rules | ✅ | `validation-export.test.ts`, fixtures |
| Typed page/element/template/chapter schemas (no AI HTML) | ✅ | `layout-pdf.test.ts` |
| 21 built-in templates incl. all 12 requested examples | ✅ | all body templates laid out without overflow at 5×8, 6×9, 8.5×11 |
| Layout engine: margins ≥ minimum, gutter alternation, bleed on outside edge, gutter tier iteration, page numbers, running headers, TOC, chapters on recto, orphan/widow control, endnotes, images | ✅ | `layout-pdf.test.ts` |
| Overflow / clipping / missing glyph / outside-safe / low DPI / thin line detection | ✅ | `layout-pdf.test.ts` |
| First 6×9 journal PDF (100 pages, embedded fonts, TrimBox) | ✅ | `fixtures.test.ts` (journal) |
| Deterministic output (byte-identical PDFs, EPUB) | ✅ | sha256 equality tests |
| Interior editor: add/remove/reorder/duplicate pages, sequences, front/back matter, field editing, element editor (form + JSON), lock pages & elements, document settings, print-size preview with zoom/guides, multi-page thumbnails, per-page issues | ✅ API / 🟢 UI | `editing-exports.test.ts`, Playwright |
| Change trim size and regenerate layout | ✅ | `editing-exports.test.ts`, `layout-pdf.test.ts` |
| Custom templates (save, version, preview at any trim, delete) | ✅ API / 🟢 UI | `editing-exports.test.ts` |
| Long-form chapter editor | 🟢 | browser |
| Footnotes | ⚠️ | rendered as per-chapter **endnotes** (print, EPUB, DOCX); no page-bottom footnotes |

## Milestone 3 — Specification engine, covers, PDF

| Task | Status | Evidence |
|---|---|---|
| Versioned spec library + `SpecSource` adapter + overrides | ✅ | `specs.test.ts` |
| Every value carries verification status/source/date; unverified → NEEDS HUMAN REVIEW | ✅ | `specs.test.ts` |
| Trim, bleed, page size, margin/gutter tiers, page-count limits by ink/paper/trim class | ✅ | `specs.test.ts` |
| Paperback cover: spine width by paper/ink, full wrap, panels, safe zones, spine text ≥ 80 pages, barcode area, RTL | ✅ | `cover-geometry.test.ts` |
| Hardcover: never from paperback formulas; official calculator/template values required; wrap & hinges | ✅ | `cover-geometry.test.ts`, API test |
| Official template import (PDF dimensions read automatically; PNG guide overlay) | ✅ API / 🟢 UI | `editing-exports.test.ts` |
| Cover editor: layers, text/typography, solid & gradient fills, images, shapes, icons, layer order, lock/hide, guides (bleed, trim, spine, safe, barcode, hinge), front/full-wrap views, drag/resize/nudge, align to safe area, duplicate/save designs, undo/redo | 🟢 | browser (Playwright check of align + undo) |
| Editable SVG export (live text, embedded fonts) | ✅ | `cover-render.test.ts` |
| Print-ready cover PDF (bleed boxes, embedded fonts, PDF shadings) | ✅ | `cover-render.test.ts`, fixtures |
| AI cover concepts as background art only; text stays live | ✅ | `e2e-workflow.test.ts` |
| Export stores spec version | ✅ | manifest test |
| Verification against live KDP pages | ⚠️ | kdp.amazon.com was unreachable from the build environment; values marked CORROBORATED (secondary sources quoting KDP) or UNVERIFIED. Re-verify before production use. |

## Milestone 4 — Metadata, providers, jobs, usage

| Task | Status | Evidence |
|---|---|---|
| Metadata workspace (all requested fields), live deterministic findings | ✅ / 🟢 | `metadata-similarity.test.ts` |
| Keyword research log with source, date, evidence; no invented volumes | ✅ | export test, UI |
| AI suggestions stored separately, only fill empty fields, labelled unverified | ✅ | `e2e-workflow.test.ts` |
| Text providers: Gemini, OpenAI-compatible, mock; image: fal.ai, mock | ✅ (adapters with fake HTTP) | `jobs-providers.test.ts` |
| Calls against live Gemini / fal.ai | ⚠️ | not exercised (no keys in this environment) |
| Retries (transient vs permanent), timeouts, rate limit, key redaction | ✅ | `jobs-providers.test.ts` |
| BullMQ queue + worker, inline runner, resumable stages, cancel at safe points, retry from UI | ✅ | `jobs-providers.test.ts`, `bullmq.test.ts` (real Redis) |
| Usage records + estimated cost, daily/monthly budgets, daily job limit | ✅ | `jobs-providers.test.ts` |
| API keys encrypted at rest, never returned or logged | ✅ | `auth-isolation.test.ts` |

## Milestone 5 — Preflight & content risk

| Task | Status | Evidence |
|---|---|---|
| Rules registry (versioned, sources, last-verified, DB mirror for audit) | ✅ | `validation-export.test.ts` |
| Technical: dimensions, page count, bleed, margins/gutter, safe area, blank pages, numbering, overflow, glyphs, font embedding, image DPI, missing images, PDF integrity/encryption/JS/annotations, file size, placeholder text, line weights, cover geometry, spine text, barcode area, cover/metadata consistency, EPUB structure, eBook cover size | ✅ | rules tests + fixtures |
| Content risk: trademark watch-list, copyright/third-party signals (incl. unlicensed uploads), portfolio near-duplicates, low-value/repetitive content, unsupported claims, restricted content, reader-expectation mismatch, AI disclosure reminder, low-content limitations | ✅ | rules tests |
| Human-review workflow (decisions + notes; carried forward only while evidence is unchanged); blocking failures cannot be "accepted" | ✅ | `editing-exports.test.ts`, `e2e-workflow.test.ts` |
| Export blocked only by explicit technical failures (plus required reviews/approval) | ✅ | `editing-exports.test.ts` |
| AI-assisted semantic checks / explanations | ❌ | all checks are deterministic heuristics; an AI explanation layer can be added on top of `RuleOutcome` |
| Preflight of externally supplied manuscript/cover PDFs | ⚠️ | `inspectPdf` works on any PDF (tested), but there is no upload-and-preflight UI for third-party PDFs yet |

## Milestone 6 — Batch, versions, exports, docs

| Task | Status | Evidence |
|---|---|---|
| Batch: CSV import with row errors, per-item brief/format/settings, differentiation & duplicate detection, cost estimates, concurrency, pause/resume/cancel, retry, quotas, manual approval with quality checklist before final export | ✅ API / 🟢 UI | `e2e-workflow.test.ts` |
| Version history: auto snapshots, named versions, undoable restore | ✅ | `e2e-workflow.test.ts` |
| Exports: interior PDF, cover PDF (paperback/hardcover), proof PDF with guides, validation report (JSON+HTML), SVG cover, project JSON, templates JSON, assets zip + design metadata, DOCX, EPUB, eBook cover PNG, metadata CSV/JSON, keyword CSV, manifest, bundle zip | ✅ | `editing-exports.test.ts`, `e2e-workflow.test.ts`, fixtures |
| Manifest checksums verified against downloaded bytes | ✅ | `editing-exports.test.ts` |
| Five fixtures generated, preflighted, PDFs verified | ✅ | `fixtures.test.ts`, `npm run fixtures` |
| End-to-end workflow (API) and browser E2E | ✅ | `e2e-workflow.test.ts`, `apps/web/e2e/workflow.spec.ts` |
| Deployment, backup/restore guidance, docker-compose for services | ✅ | README |

## Milestone 7 — Image model library (fal.ai) with live pricing

| Task | Status | Evidence |
|---|---|---|
| Investigate fal's official catalog/pricing data (Platform API models, pricing, usage; SDK queue; billable-units header) | ✅ | README “Image model library”; endpoints documented |
| Catalog sync via `GET /v1/models` (find ≤ 50 ids, category search, cursor pagination, `expand=openapi-3.0`); not-found ids disabled | ✅ (simulated HTTP) | `image-models.test.ts` |
| Capabilities derived from each endpoint's OpenAPI schema (sizes, ratios, resolutions, negative prompt, references, masks, seeds, tasks with evidence) | ✅ | `models.test.ts` |
| Pricing: units normalised (image / megapixel / token / second / request), never relabelled; source, currency, retrieval time, assumptions; stale detection; history | ✅ | `models.test.ts`, `image-models.test.ts` |
| “Price unavailable” + explicit acceptance; estimates for 1/4/10/50/100; token models need assumptions | ✅ | API + core tests |
| Actual cost from `X-Fal-Billable-Units`; “not reported” otherwise; provider usage sync (Admin key) | ✅ header path tested / ⚠️ usage endpoint parsing untested against live data | `image-models.test.ts` |
| SDK adapter (server only), schema validation, timeouts, retries, error mapping, resumable request ids (no double charge) | ✅ (simulated HTTP) | `image-models.test.ts` |
| Spending limits: workspace daily/monthly, project, member, book | ✅ | API tests |
| Gallery: search, filters (cheapest, concept drafts, illustrated, photorealistic, typography, editing, references, high-res, commercial info, t2i, i2i…), cards, live estimate, Select/preferred | 🟢 | browser walkthrough |
| Compare models with one brief (one image each, confirmed total, actual cost, ratings, set preferred) | ✅ API / 🟢 UI | `image-models.test.ts` |
| Platform admin: sync, enable, tags, limitations, commercial-use link, manual price with https source, assumptions | ✅ API / 🟢 UI | `image-models.test.ts` |
| Cover art flow: brief → model → estimate → confirm → generate → preview/revise (i2i) → placed under live text; geometry from the verified cover spec | ✅ API / 🟢 UI | `image-models.test.ts`, browser |
| **Live fal calls (≥ 3 models)** | ❌ not done | `fal.ai`, `api.fal.ai`, `queue.fal.run` were unreachable from the build environment and no key was available. All fal behaviour is tested against a simulated HTTP layer shaped after the documented API. Run a catalog sync and a test generation with a real `FAL_KEY` before relying on it. |

## Milestone 8 — Coloring Book Studio

| Task | Status | Evidence |
|---|---|---|
| Dashboard: stages, approved/target, est. vs actual cost, progress, duplicate, archive, search/sort/filter | ✅ API / ✅ E2E | `coloring.test.ts`, `coloring.spec.ts` |
| Wizard: concept, audience presets (Toddlers→Seniors), theme presets, art direction controls, reusable style profiles, trim, single-sided, model, budget | ✅ | API + E2E |
| Deterministic prompt builder with coloring defaults; hand-edited prompts preserved; repeated-concept detection | ✅ | core + API tests |
| Page plan per page: concept, prompt, negative prompt, model, params, references, versions, cost, QC | ✅ | `coloring.test.ts` |
| Batch generation as a background job: confirmed estimate, budget cap, resumable, finished pages preserved, modes new/variation/edit | ✅ (offline mock + priced mock) | `coloring.test.ts` |
| Review: approve/reject/favorite/duplicate/replace/restore/compare versions/re-process, bulk actions | ✅ API / 🟢 UI | API test, E2E |
| QC: decode, DPI, aspect, alpha (automated); background, color, gray, contrast, ink, line weight, cropping, empty areas, perceptual-hash duplicates (heuristic); text/watermark/quality/originality (manual) | ✅ | `coloring.test.ts` (synthetic images) |
| Processing (originals preserved): flatten, grayscale, normalise, denoise, threshold, trim, pad-to-aspect, resample to 300 DPI | ✅ | `coloring.test.ts` |
| Override of failed QC requires a note; recorded | ✅ | `coloring.test.ts` |
| Interior from approved pages: trims, single-sided blank reverses, recto placement, front/back matter, scale/alignment, real PDF, preview | ✅ | core + API + E2E |
| Cover: existing full-wrap designer + AI art dialog | ✅ (reused) | Milestone 3/7 |
| Unified preflight: automated / visual warnings / manual / official-needs-verification, no approval guarantee | ✅ | `coloring.test.ts`, E2E |
| Metadata: back-cover copy, coloring checklist (no invented demand, trademark reminder, AI disclosure) | 🟢 | browser |
| Export package: interior PDF, cover PDF, editable SVG, proof, page images (original + print), prompt log CSV, QC report JSON/HTML, metadata, manifest | ✅ | `coloring.test.ts` |
| AI upscaling via an upscale model | ⚠️ | upscale models are in the catalog, but the studio's “resample to 300 DPI” is Lanczos resampling (stated as adding no detail) |
| Automatic text/watermark detection | ❌ | listed as a manual check; no OCR is bundled |

## Known limitations / next steps

- fal.ai integration is untested against the live service (see Milestone 7). Seed model ids and the exact `/v1/models/usage` response shape must be confirmed with a real key.
- The original phase-13 request was cut off after “Editable SVG cover, when supported”; anything listed after that point was not received.
- Kindle **fixed-layout** eBooks (Kindle Create / Kids' Book Creator workflows) are not generated; only reflowable EPUB. EPUB validation is a structural subset, not EPUBCheck.
- Covers are produced in RGB; no PDF/X or CMYK conversion. KDP accepts standard PDFs, but colour-critical work should be proofed.
- Rate limiting and provider throttling are per process (no shared Redis store yet).
- No email verification / password reset flow.
- No Dockerfile for the app itself (services via docker-compose; app via Node).
- Cover editor has no multi-select or snapping; alignment is via buttons and numeric inputs.
- Trademark screening is a small watch-list, not a trademark database search.
