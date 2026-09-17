# Architecture

This document defines module boundaries, tech stack, and repo layout for implementation. `README.md` is the product spec (what and why); this is the how.

## Tech stack (recommended, not mandated)

| Concern | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript on Node.js | OpusClip ships an official Node SDK; Google APIs have mature Node clients; one language across API + workers keeps the codebase small. |
| HTTP API | Fastify | Lightweight, typed, good for a small internal service. |
| Database | Render Postgres (managed) | Transactional guarantees are required (see README § Reliability). Use a real migration tool (Prisma, Drizzle, or Knex) — do not hand-roll SQL migrations. A plain managed instance, not forced through a transaction-mode connection pooler, so `pg-boss` works without the session-state caveats a pooled provider would introduce. Also keeps database + compute on one platform/bill. |
| File storage | Cloudflare R2 | S3-API-compatible (same `@aws-sdk/client-s3` code, no bespoke SDK), zero egress fees — relevant here since every approved clip's export gets downloaded by a reviewer/poster. Used for `Ready to Post` / `Archive` / `Needs Attention` export artifacts (final.mp4, thumbnails, caption files). |
| Job queue | `pg-boss` (Postgres-backed) | Avoids standing up Redis for a queue this small; jobs and application data share one transactional store, which simplifies idempotency (job state and business state can commit together). Swap for BullMQ+Redis only if throughput later demands it. |
| Requirements extraction | Claude API (Messages API, structured output) | Already the AI build tool in use; ask for a JSON object matching the campaign config schema, with a confidence field per extracted value. |
| Secrets | Environment variables, loaded via a single `config.ts` that validates presence at boot | No secrets in code or DB rows. |

If the implementer picks a different stack, keep the module boundaries below — they matter more than the specific libraries.

## Module boundaries

Each module is a directory under `src/modules/<name>/` with its own types, and talks to other modules only through the interfaces below — not by reaching into another module's internals or DB tables directly. This keeps each piece independently testable and replaceable (e.g. swapping OpusClip for another clipping provider later should only touch `project-creator` and `project-monitor`).

### `campaign-connector`
- **Input:** a Content Rewards campaign URL.
- **Output:** `{ campaignId, title, brand, platforms, payoutRaw, guidelineDocUrl, driveFolderUrl }`.
- **Responsibility:** resolve the canonical campaign ID from the URL (see `API_CONTRACTS.md` for the redirect trick used to find it), fetch the discover page, and extract the embedded campaign JSON. This page is **not an official API** — isolate the parsing (a single `parseDiscoverPageHtml()` function) so that if Content Rewards changes their markup, only this one function needs fixing.
- **Failure mode:** if the campaign JSON can't be found/parsed, this is a hard failure — surface it, don't guess.

### `requirements-extractor`
- **Input:** guideline doc text (plain text, already fetched).
- **Output:** a draft `CampaignConfig` (see `DATA_MODEL.md`) with a `confidence` map per field (`high` / `low`) and a list of fields it could not find at all.
- **Responsibility:** one LLM call with a strict JSON schema response. Never silently defaults a field it didn't find — leaves it null and flags it.
- **This module's output is never used directly.** It always passes through human confirmation (see `review-api`) before a campaign becomes `active`.

### `footage-enumerator`
- **Input:** a Drive folder URL/ID, a campaign ID.
- **Output:** a list of `{ driveFileId, name, sizeBytes, md5Checksum, mimeType }` for files not previously seen for that campaign.
- **Responsibility:** poll the public Drive folder (see `API_CONTRACTS.md` for the listing approach) on an interval; diff against `source_jobs.drive_file_id` already recorded for the campaign; emit one new source job per unseen file.

### `job-queue`
- pg-boss queues: `validate-source`, `create-project`, `poll-project`, `run-checks`, `notify`.
- **Responsibility:** decouple detection from processing so a slow/unavailable downstream (OpusClip rate limit, Drive quota) doesn't block ingestion.

### `project-creator`
- **Input:** a validated source job.
- **Output:** an OpusClip `projectId`, or a typed failure (`unreachable_source`, `rate_limited`, `insufficient_credits`, `rejected`).
- **Responsibility:** run the pre-flight reachability check (HEAD request on the Drive file URL) before calling OpusClip; submit `POST /api/clip-projects`; persist the returned project ID against the source job immediately (before any further processing) so a crash here can't orphan a created project.

### `project-monitor`
- **Input:** an OpusClip `projectId`.
- **Output:** candidate clip records (from `GET /api/exportable-clips`).
- **Responsibility:** poll on a backoff schedule; also exposes a webhook receiver endpoint for OpusClip's `conclusionActions` callback (verify the payload before trusting it — see `API_CONTRACTS.md`); either path writes to the same `candidate_clips` table, so polling is a correct fallback if the webhook never arrives.

### `compliance-service`
- **Input:** a candidate clip + its campaign's confirmed config.
- **Output:** a list of check results, each `pass` / `fail` / `manual_review_required`.
- **Responsibility:** pure rule evaluation against objectively-checkable fields (duration, aspect ratio, template ID used, export success). Never invents a `pass` for something it can't verify (e.g. "watermark present") — those checks either have a real verification method or they default to `manual_review_required`.

### `review-api`
- **Responsibility:** the human-facing surface — confirming extracted campaign requirements, and approving/rejecting/editing candidate clips. This is the one module it's reasonable to build as a thin CRUD layer first and a real UI later (README Phase 2).

### `tracker`
- The Postgres database itself, accessed through each module's own repository functions — not a shared "god" data-access module. See `DATA_MODEL.md` for schema.

### `notifier`
- **Responsibility:** send an alert (email/Slack — pick one for v1) whenever a campaign or source job enters `needs_attention`, or a campaign's requirements are `pending_confirmation` for more than a set time. This module is explicitly called out in the README as previously-missing; do not skip it in Phase 1.

## Repo layout

```
clipper/
  README.md                # product spec
  docs/
    ARCHITECTURE.md         # this file
    DATA_MODEL.md
    API_CONTRACTS.md
    BUILD_PLAN.md
  src/
    config.ts                # env var loading + validation
    db/
      migrations/
      schema.ts
    modules/
      campaign-connector/
      requirements-extractor/
      footage-enumerator/
      project-creator/
      project-monitor/
      compliance-service/
      review-api/
      notifier/
    queue/
      index.ts               # pg-boss setup, queue names
      workers/                # one file per queue worker
    server.ts                 # Fastify app: review-api routes + webhook receiver
  test/
    modules/                  # one test dir per module, mirroring src/modules
```
