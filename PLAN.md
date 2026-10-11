# KDP Product Factory — Implementation Plan

## 0. Repository inspection (done)

The repository `domain-names` already contains a working, unrelated Next.js product
("DomainPulse", a domain-valuation SaaS) at the repository root, with its own Prisma
schema, Vercel config and tests.

**Decision (safe default, no destructive change):** KDP Product Factory is built as a
self-contained npm-workspaces monorepo in `kdp-factory/`. DomainPulse is left untouched and
keeps deploying from the root (`vercel.json` pins it to Next.js). The KDP app uses the stack
requested in the brief (React + Vite + Express + Prisma + BullMQ) because none of DomainPulse's
code (domain valuation) is reusable for publishing, and mixing two products into one Next.js
app would couple their deployments, schemas and auth. If the owner later wants the KDP app to
replace DomainPulse, `kdp-factory/` can be promoted to the root in one move.

**Update (October 2026):** the owner moved the project to its own repository,
`kdp-product-factory`, where the former `kdp-factory/` contents are the repository root and the
domain-valuation app is not included. The app also deploys to Vercel (see README).

## 1. Guiding principles

1. **Deterministic core first.** Print geometry, layout, PDF rendering, and technical
   validation are pure TypeScript in `packages/core`, with no AI and no I/O beyond reading
   bundled fonts. Same input → byte-identical PDF.
2. **Specifications are data, not code.** Every KDP number lives in a versioned
   specification record with a source URL and a `verified` flag. Unverified values are
   surfaced as `NEEDS HUMAN REVIEW`, never silently used as fact.
3. **AI is an assistant, not an authority.** AI providers draft outlines, prose, metadata and
   cover art. Typography, geometry, barcodes, and pass/fail technical checks never come from a
   model.
4. **Human approval gates.** Exports require a passing technical preflight; final export of a
   batch item requires manual approval. Nothing is published to Amazon automatically.
5. **No guarantees.** The UI and reports state that validation reduces risk; it does not
   guarantee KDP acceptance, sales, or policy compliance.

## 2. Milestones

| # | Scope | Exit criteria |
|---|-------|---------------|
| 1 | Plan docs, monorepo scaffold, Prisma schema + migration, auth (scrypt + DB sessions), workspace isolation, project CRUD, dashboard shell | API + web start; auth/isolation tests pass |
| 2 | Wizard, product/template schemas, deterministic layout engine, interior PDF renderer, first 6×9 journal PDF | Fixture journal PDF renders with embedded fonts, correct boxes; tests pass |
| 3 | Spec engine (versioned registry + adapter), cover geometry (paperback, hardcover via official-calculator input), cover editor model, SVG + PDF cover export | Geometry tests vs. KDP formulas; cover PDFs verified |
| 4 | Metadata workspace, text/image provider abstraction (Gemini, OpenAI-compatible, fal.ai, mock), BullMQ jobs, usage + cost tracking | Provider failure + retry tests pass |
| 5 | Technical preflight (PDF inspection), content-risk checks, rules registry with sources and verification dates, human-review workflow | Every fixture preflighted; blocking rules enforced |
| 6 | Batch generation (CSV, pause/resume, quotas, duplicate detection, approval), version history, DOCX/EPUB/CSV/JSON/SVG exports, manifest, deployment docs, E2E | Full DoD walk-through in automated E2E test |

## 3. Definition of done (MVP)

A user can: create a project → select a KDP format → configure a brief → generate or edit an
original interior → design or import a cover → render a valid PDF → run technical validation →
review policy warnings → correct issues → export manuscript and cover → reopen the project
without losing edits → run the automated tests successfully.

Status of each item is tracked in [TASKS.md](TASKS.md).
