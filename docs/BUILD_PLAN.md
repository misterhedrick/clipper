# Build Plan

Ordered Phase 1 tasks. Each task has a concrete "done when" check. Build and verify in order, since later tasks assume earlier ones work.

Revised 2026-09-22 for the Claude-operator design (`ARCHITECTURE.md`). The original tasks 3–14 assumed Drive-only footage, a code-based LLM extractor and a queue worker. The survey (`CAMPAIGN_SURVEY.md`) showed none of that fits. Tasks 0–2 are unchanged and done.

An earlier, separate Phase 1 build on the old design (commit `c55ad2e`: Drive-only, pg-boss worker, in-app Claude API call) was merged into `develop` with this design taking precedence. Its code is no longer in the tree. The tasks below name the pieces worth porting from it.

## 0. Project scaffold ✅ done
Fastify app, zod-validated config that fails at boot, `GET /health` backed by a real DB query.

## 1. Database ✅ done
Drizzle schema + migrations for `campaigns`, `source_jobs`, `candidate_clips`, `status_events`, `posts`, with DB-enforced dedupe and status vocabularies.

## 2. `campaign-connector` ✅ done
Content Rewards URL → metadata + reference materials. Live canary test: `RUN_NETWORK_TESTS=1 npm test -- live`.

## 3. Schema v2 + config cleanup
- Migration per `DATA_MODEL.md` § "v2 changes": `campaigns.campaign_type`, `footage_sources` table, `source_jobs.source_key`/`source_kind` (replacing `drive_file_id`), candidate `prescreen_*` and `caption` columns, `credit_ledger`.
- Drop `ANTHROPIC_API_KEY` and `GOOGLE_API_KEY` from required config (the app makes no LLM calls, and Drive listing is keyless). Add `OPUSCLIP_DAILY_CREDIT_BUDGET` and `REVIEWER_TOKEN`.
- A single `transition()` helper per entity: updates status and inserts `status_events` in one transaction. Nothing else writes a `status` column.
- **Done when:** migrations apply on top of v1. The duplicate `(campaign_id, source_key)` test passes. A test proves `transition()` writes the audit row atomically: a forced failure after the update leaves neither the update nor the event.

## 4. CLI skeleton + campaign commands
- `clipper` bin: JSON on stdout, `{error:{code,message}}` + non-zero exit on failure, `actor = 'claude-operator'` on every write.
- `campaign scout | add | show | list | classify | flag`.
- `scout` parses the discover listing page (same RSC approach as `campaign-connector`; the listing has better `description` data).
- **Done when:** `clipper campaign add <MW4 url>` creates a row, a second `add` is a no-op returning the same ID, and `scout` lists ~50 campaigns with titles and platforms (network test).

## 5. `brief-reader` + `campaign brief`
- Fetch the doc as `export?format=html`. Return the plain text **and** every hyperlink, unwrapping `google.com/url?q=` redirects. `--doc <url>` reads a linked sub-doc.
- A 401 or redirect to sign-in → `{error:{code:"not_public"}}`, never retried.
- **Done when:** for survey campaigns #25 (PULP) and #39 (Ryan Zofay), the output includes the Drive folder links that plain-text export drops.

## 6. Campaign config schema + `propose-config`
- zod `CampaignConfig` (per `DATA_MODEL.md`), with `review.autoApprove` as `z.literal(false)`.
- `propose-config` validates, stores and moves to `pending_confirmation`. It **cannot** move to `active`.
- **Done when:** an invalid config is rejected with field-level errors; `autoApprove: true` is rejected; grepping `src/cli` finds no path that sets `active`.

## 7. `footage-sources` + footage commands
- URL → kind classifier for every row in `ARCHITECTURE.md` § "Footage source kinds".
- Drive folder listing via `embeddedfolderview` (recursive, depth-limited, with folder path per file). YouTube channel → channel ID → RSS feed.
- `footage add | list-url | select | skip`. `select` creates a `source_jobs` row (`detected`); `skip` records a decision so later runs don't re-evaluate.
- **Done when:** `list-url` on survey folders #46 (Nilo, 7 subfolders) and #23 (Charlie Berens, 2 MP4s) returns the right structure. Running `select` twice on the same file creates one job.
- **Open item:** Dropbox shared-folder listing. Try the `?dl=0` HTML listing first. If that isn't feasible, Dropbox folders are human-picked file links for v1.

## 8. OpusClip client + `source validate | submit` + `credits`
- Typed client for create-project and get-clips (`API_CONTRACTS.md`). Add a rate limiter (30/min).
- `submit`: atomic credit reservation in `credit_ledger` against the daily and per-campaign budget, `submitting` lock state, persist `opusclip_project_id` before returning.
- Failure classification per README § Retry policy.
- **Done when:** a short public test video submits and gets a project ID. A second `submit` on the same job returns the same project with no API call. Exceeding the budget is refused before any API call.
- **Port, don't rewrite:** `src/lib/opusclip.ts` and `src/modules/project-creator/validateSource.ts` from the earlier Phase 1 build (commit `c55ad2e`, in `develop`'s history). They already have a typed client with retryable/permanent error classification. Adapt them to the v2 schema and the credit ledger.

## 9. `clipper sync`
- Poll `project_created`/`processing` jobs → upsert candidates → run objective checks (`compliance`) → `awaiting_review`. Retry transient failures with backoff and a max count.
- **Done when:** candidates appear for the task-8 project from polling alone, and a re-run creates no duplicates.
- **Port:** `src/modules/compliance-service/` and its tests from `c55ad2e`. Its objective checks already default unverifiable checks to `manual_review_required`.

## 10. Caption validation + `candidate prescreen | set-caption`
- `compliance.validateCaption(caption, config)`: exact-match required lines, required tags, disclosures (on their own line when required), hashtag limit.
- **Done when:** the MW4 caption rules (exact pre-order phrase, `@callofduty`, `#Ad` on its own line) accept a compliant caption and reject each single omission with a specific reason.

## 11. Review web app
- Server-rendered pages on the existing Fastify app, behind `REVIEWER_TOKEN` for v1: campaigns awaiting confirmation (edit + confirm → `active`), candidate queue with preview video, checks, prescreen notes and caption (approve / needs edit / reject / hold), post recording.
- **Done when:** approve is only reachable through an authenticated request, and every decision writes a `status_events` row with the reviewer as actor.

## 12. Packaging + notifier
- On approval: fetch `uriForExport` (poll if not ready), write `final.mp4`, `caption.txt`, `clip-metadata.json` and `thumbnail.jpg` to R2 → `ready_to_post`.
- `notifier` webhook for `needs_attention`, configs waiting over 24h, and operator reports (`clipper notify`).
- **Done when:** an approved candidate produces the full bundle in R2, and a forced validation failure delivers a real notification.
- **Port:** `src/lib/r2.ts` (streaming multipart upload, never buffers the file), `src/modules/export/` and `src/modules/notifier/` from `c55ad2e`.
- **Known gap from that build:** OpusClip's get-clips response has no thumbnail field. Confirm whether one exists before building `thumbnail.jpg`; otherwise ship the bundle without it and say so, rather than faking one.

## 13. Operator deployment
- Render: web service + Render Cron Job (`clipper sync` every 10 min). No background worker.
- Claude Code Routine on this repo, running the `clipper-operator` skill a few times a day, with `DATABASE_URL`, `OPUSCLIP_API_KEY`, `OPUSCLIP_DAILY_CREDIT_BUDGET` and `NOTIFY_WEBHOOK_URL` in its environment.
- **Done when:** a scheduled run completes the loop on an empty queue and posts a "nothing needs you" report.

## 14. End-to-end on a real campaign
- Pick an LF campaign with a public Drive folder of full-length footage (survey #23 Charlie Berens is a good candidate). Scout → add → onboard → confirm → source → submit → sync → pre-screen → approve → Ready to Post.
- **Done when:** it runs clean twice with no duplicate jobs or candidates on the second pass, and every transition has a `status_events` row.

---

Don't start Phase 2 (richer review UI, webhook-driven sync, performance tracking) until task 14 passes on a real campaign.
