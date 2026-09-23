# Build Plan

Ordered Phase 1 tasks. Each task has a concrete "done when" check. Build and verify in order, since later tasks assume earlier ones work.

Revised 2026-09-22 for the Claude-operator design (`ARCHITECTURE.md`). The original tasks 3–14 assumed Drive-only footage, a code-based LLM extractor and a queue worker. The survey (`CAMPAIGN_SURVEY.md`) showed none of that fits. Tasks 0–2 are unchanged and done.

Updated again the same day: OpusClip is now reached through the **OpusClip connector** (MCP, Pro plan) from the operator session instead of an API client in our code. Tasks 8, 9, 12 and 13 changed accordingly. See `ARCHITECTURE.md` § "OpusClip via the connector".

An earlier, separate Phase 1 build on the old design (commit `c55ad2e`: Drive-only, pg-boss worker, in-app Claude API call) was merged into `develop` with this design taking precedence. Its code is no longer in the tree. The tasks below name the pieces worth porting from it.

## 0. Project scaffold ✅ done
Fastify app, zod-validated config that fails at boot, `GET /health` backed by a real DB query.

## 1. Database ✅ done
Drizzle schema + migrations for `campaigns`, `source_jobs`, `candidate_clips`, `status_events`, `posts`, with DB-enforced dedupe and status vocabularies.

## 2. `campaign-connector` ✅ done
Content Rewards URL → metadata + reference materials. Live canary test: `RUN_NETWORK_TESTS=1 npm test -- live`.

## 3. Schema v2 + config cleanup ✅ done
- Migration per `DATA_MODEL.md` § "v2 changes": `campaigns.campaign_type`, `footage_sources` table, `source_jobs.source_key`/`source_kind` (replacing `drive_file_id`), candidate `prescreen_*` and `caption` columns, `credit_ledger`.
- Drop `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` and `OPUSCLIP_API_KEY` from required config (the app makes no LLM or OpusClip calls, and Drive listing is keyless). Add `OPUSCLIP_DAILY_CREDIT_BUDGET` and `REVIEWER_TOKEN`. R2 and notifier vars become required only by the commands that use them, not at boot of every entry point.
- A single `transition()` helper per entity: updates status and inserts `status_events` in one transaction. Nothing else writes a `status` column.
- **Done when:** migrations apply on top of v1. The duplicate `(campaign_id, source_key)` test passes. A test proves `transition()` writes the audit row atomically: a forced failure after the update leaves neither the update nor the event.
- **Outcome:** migrations `0001`/`0002` apply in order on an empty DB; `transition()` also enforces allowed transitions and **human-only** moves (campaign → `active`, clip approve/edit/reject/posted need a `reviewer:` actor); a static test blocks status writes outside `transition()`. Config now loads per section (`db`, `server`, `credits`, `r2`, `notify`).

## 4. CLI skeleton + campaign commands ✅ done
- `clipper` bin: JSON on stdout, `{error:{code,message}}` + non-zero exit on failure, `actor = 'claude-operator'` on every write.
- `campaign scout | add | show | list | classify | flag`.
- `scout` parses the discover listing page (same RSC approach as `campaign-connector`; the listing has better `description` data).
- **Done when:** `clipper campaign add <MW4 url>` creates a row, a second `add` is a no-op returning the same ID, and `scout` lists ~50 campaigns with titles and platforms (network test).
- **Outcome:** verified live (add → created, re-add via `/campaigns/` URL → same ID, scout → 50 listed). Added migration `0003`: `campaigns.cr_snapshot` (payouts/budget/reference materials for the operator) and `audit_log` for non-status writes. `npx clipper …` runs via `bin/clipper`. `guard submit` exists as a stub that blocks every submission until task 8.

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

## 8. Credit ledger + submit protocol + guard hook
- `source validate` (host supported, publicly reachable, campaign active → `queued`), `source reserve`, `source record-project`, `source record-failure`, `credits`, `credits reconcile` per `ARCHITECTURE.md`.
- `reserve` is one transaction: dedupe (job `queued`, no project, no open reservation) + daily/per-campaign budget + `--opus-remaining` → reservation row, job → `submitting`, `submit_params` stored and returned. Default estimate 90 min when duration is unknown.
- `record-failure` classifies connector errors: rate limit, timeout or Drive quota → retryable (job back to `queued`, `retry_count`+1, max 3 → `needs_attention`); unsupported URL, private source or no credits → permanent (`submit_failed`). The reservation is released either way.
- `clipper guard submit`: reads the hook payload, allows only an exact `submit_params` match for a `submitting` job with an open reservation. Replaces the placeholder in `.claude/hooks/guard-opusclip-submit.sh`.
- **Done when:**
  - Unit: reserving the same job twice fails the second time. Over-budget or over-`opus-remaining` is refused with no state change. Every reservation/release is audited.
  - Hook: a payload with a changed `videoUrl`, a missing title, or no reservation exits 2; an exact match exits 0.
  - Live: one real submission of a **10-minute range** (`--range 0-600`) goes reserve → connector → record-project, and `opusclip_get_usage` rises by roughly 10.
- **Port:** the error classification from `src/lib/opusclip.ts` and `src/modules/project-creator/validateSource.ts` in commit `c55ad2e`.

## 9. Collecting clips: `candidate upsert` + objective checks
- The operator calls `opusclip_list_clips` for each `project_created`/`processing` job and passes the JSON to `clipper candidate upsert <jobId> --file`. The CLI validates it with zod, dedupes by OpusClip clip ID, stores score/title/description/hashtags/duration/preview URL, runs objective checks, and moves new candidates to `awaiting_review`. If the project `stage` is still in progress, the job becomes `processing` with no candidates.
- Retries: a job stuck in `processing` past a max wait (e.g. 6h) → `needs_attention`.
- **Done when:** upserting the live task-8 project's clips twice creates each candidate once, and a fixture with a wrong-aspect clip fails that check.
- **Port:** `src/modules/compliance-service/` and its tests from `c55ad2e`.

## 10. Caption validation + `candidate prescreen | set-caption`
- `compliance.validateCaption(caption, config)`: exact-match required lines, required tags, disclosures (on their own line when required), hashtag limit.
- `candidate record-edit`: logs a connector `opusclip_edit_clip` call (ops + reason), only for candidates a reviewer marked `needs_edit`; the candidate returns to `awaiting_review`.
- **Done when:** the MW4 caption rules (exact pre-order phrase, `@callofduty`, `#Ad` on its own line) accept a compliant caption and reject each single omission with a specific reason; `record-edit` on a candidate not in `needs_edit` is refused.

## 11. Review web app
- Server-rendered pages on the existing Fastify app, behind `REVIEWER_TOKEN` for v1: campaigns awaiting confirmation (edit + confirm → `active`), candidate queue with preview video, checks, prescreen notes and caption (approve / needs edit / reject / hold), post recording.
- **Done when:** approve is only reachable through an authenticated request, and every decision writes a `status_events` row with the reviewer as actor.

## 12. Packaging + notifier
- For approved candidates, the operator calls `opusclip_export_clip` (polling `rendering` → `ready`) and records the URL with `candidate record-export`. `clipper package <id>` then streams the export into R2 as `final.mp4` with `caption.txt`, `clip-metadata.json` and `thumbnail.jpg` → `ready_to_post`. It refuses any candidate a human didn't approve.
- Thumbnail: `opusclip_list_clips` returns thumbnail URLs, which resolves the gap found in `c55ad2e`. Verify on the live project.
- `notifier` webhook for `needs_attention`, configs waiting over 24h, and operator reports (`clipper notify`).
- **Done when:** an approved candidate produces the full bundle in R2, packaging a non-approved candidate is refused, and a forced validation failure delivers a real notification.
- **Port:** `src/lib/r2.ts` (streaming multipart upload), `src/modules/export/` and `src/modules/notifier/` from `c55ad2e`.

## 13. Operator deployment
- Render: web service (review app + `/health`) and Postgres only. No worker, no cron.
- Claude Code Routine on this repo, hourly, running the `clipper-operator` skill, with the OpusClip connector attached and `DATABASE_URL`, `OPUSCLIP_DAILY_CREDIT_BUDGET` and `NOTIFY_WEBHOOK_URL` in its environment. The project `.claude/settings.json` (submit guard hook, denied posting tools) must be active there. Verify by attempting a forbidden call in a dry run and seeing it refused.
- **Done when:** a scheduled run completes the loop on an empty queue and posts a "nothing needs you" report, and a deliberately unreserved submit in that environment is blocked by the hook.

## 14. End-to-end on a real campaign
- Pick an LF campaign with a public Drive folder of full-length footage (survey #23 Charlie Berens is a good candidate). Scout → add → onboard → confirm → source → reserve/submit → collect → pre-screen → approve → export → package → Ready to Post. Start with a range-limited submit, then a full video.
- **Done when:** it runs clean twice with no duplicate jobs or candidates on the second pass, and every transition has a `status_events` row.

---

Don't start Phase 2 (richer review UI, webhook-driven sync, performance tracking) until task 14 passes on a real campaign.
