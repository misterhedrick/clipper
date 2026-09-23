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

## 5. `brief-reader` + `campaign brief` ✅ done
- Fetch the doc as `export?format=html`. Return the plain text **and** every hyperlink, unwrapping `google.com/url?q=` redirects. `--doc <url>` reads a linked sub-doc.
- A 401 or redirect to sign-in → `{error:{code:"not_public"}}`, never retried.
- **Done when:** for survey campaigns #25 (PULP) and #39 (Ryan Zofay), the output includes the Drive folder links that plain-text export drops.
- **Outcome:** verified live, including that PULP's text export lacks its `PULP Assets Folder` link while `brief` shows it inline. The text renders every link as `words <url>`, so Claude sees what each link is called (`VIDEO OVERLAY`, `Clip Examples Folder`, …), which matters for telling footage from assets. `brief` also returns `linkedDocs` (sub-docs to read with `--doc`) and the campaign page's reference materials; with no doc it returns `doc: null` plus a note rather than failing.

## 6. Campaign config schema + `propose-config` ✅ done
- zod `CampaignConfig` (per `DATA_MODEL.md`), with `review.autoApprove` as `z.literal(false)`.
- `propose-config` validates, stores and moves to `pending_confirmation`. It **cannot** move to `active`.
- **Done when:** an invalid config is rejected with field-level errors; `autoApprove: true` is rejected; grepping `src/cli` finds no path that sets `active`.
- **Outcome:** schema lives in `src/modules/campaign-config` (zod, strict: unknown/misspelled keys are errors) and the DB type derives from it. Every field needs a confidence or an `unresolvedFields` entry; `extraction.unexpressedRules` carries brief rules the config can't express for the reviewer. `propose-config` requires `campaignType = lf`, works from discovered / requirements_drafted / pending_confirmation / needs_attention, voids any earlier confirmation, and audits the draft; `--dry-run` validates only. A static test keeps the `active` literal out of `src/cli`. Verified on MW4 (now `pending_confirmation`).

## 7. `footage-sources` + footage commands ✅ done
- URL → kind classifier for every row in `ARCHITECTURE.md` § "Footage source kinds".
- Drive folder listing via `embeddedfolderview` (recursive, depth-limited, with folder path per file). YouTube channel → channel ID → RSS feed.
- `footage add | list-url | select | skip`. `select` creates a `source_jobs` row (`detected`); `skip` records a decision so later runs don't re-evaluate.
- **Done when:** `list-url` on survey folders #46 (Nilo, 7 subfolders) and #23 (Charlie Berens, 2 MP4s) returns the right structure. Running `select` twice on the same file creates one job.
- **Open item:** Dropbox shared-folder listing. Try the `?dl=0` HTML listing first. If that isn't feasible, Dropbox folders are human-picked file links for v1.
- **Outcome:** verified live. Nilo lists 13 folders and 137 files with videos told apart from docs and images; Berens lists its 2 specials; a YouTube @handle resolves via the page's canonical link to its 15 most recent uploads, with Shorts flagged. `select` takes the video `--url` (the source key is derived, not typed), is idempotent, and decisions are final (`already_decided`). `list-url --campaign` marks decided videos and counts `undecidedVideos`. **Dropbox:** the shared-folder page renders client-side (no file names in the HTML), so folders stay human-picked file links for v1; `list-url` says so.

**Milestone A (tasks 3–7) is complete:** Claude can scout, add, classify, read briefs, propose configs, and choose footage, all through the CLI, with nothing spent.

## 8. Credit ledger + submit protocol + guard hook ✅ code done · live check pending
- `source validate` (host supported, publicly reachable, campaign active → `queued`), `source reserve`, `source record-project`, `source record-failure`, `credits`, `credits reconcile` per `ARCHITECTURE.md`.
- `reserve` is one transaction: dedupe (job `queued`, no project, no open reservation) + daily/per-campaign budget + `--opus-remaining` → reservation row, job → `submitting`, `submit_params` stored and returned. Default estimate 90 min when duration is unknown.
- `record-failure` classifies connector errors: rate limit, timeout or Drive quota → retryable (job back to `queued`, `retry_count`+1, max 3 → `needs_attention`); unsupported URL, private source or no credits → permanent (`submit_failed`). The reservation is released either way.
- `clipper guard submit`: reads the hook payload, allows only an exact `submit_params` match for a `submitting` job with an open reservation. Replaces the placeholder in `.claude/hooks/guard-opusclip-submit.sh`.
- **Done when:**
  - Unit: reserving the same job twice fails the second time. Over-budget or over-`opus-remaining` is refused with no state change. Every reservation/release is audited.
  - Hook: a payload with a changed `videoUrl`, a missing title, or no reservation exits 2; an exact match exits 0.
  - Live: one real submission of a **10-minute range** (`--range 0-600`) goes reserve → connector → record-project, and `opusclip_get_usage` rises by roughly 10.
- **Port:** the error classification from `src/lib/opusclip.ts` and `src/modules/project-creator/validateSource.ts` in commit `c55ad2e`.
- **Outcome:** unit and hook checks pass, including an end-to-end run of the real hook script (exact match → exit 0, tampered `videoUrl` → exit 2). Also covered: budget lock under concurrency (3 parallel reserves, budget for 2 → exactly 2 pass), per-campaign cap, retries (3 transient → `needs_attention`), and a closed reservation blocking a second submit of the same video. Reachability: Drive = no sign-in redirect, YouTube = oEmbed, S3 = HEAD. **Pending:** the live 10-minute submission. It needs an `active` campaign, which only a reviewer can create (task 11), plus your go-ahead to spend ~10 credits.

## 9. Collecting clips: `candidate upsert` + objective checks ✅ code done · live check pending
- The operator calls `opusclip_list_clips` for each `project_created`/`processing` job and passes the JSON to `clipper candidate upsert <jobId> --file`. The CLI validates it with zod, dedupes by OpusClip clip ID, stores score/title/description/hashtags/duration/preview URL, runs objective checks, and moves new candidates to `awaiting_review`. If the project `stage` is still in progress, the job becomes `processing` with no candidates.
- Retries: a job stuck in `processing` past a max wait (e.g. 6h) → `needs_attention`.
- **Done when:** upserting the live task-8 project's clips twice creates each candidate once, and a fixture with a wrong-aspect clip fails that check.
- **Port:** `src/modules/compliance-service/` and its tests from `c55ad2e`.
- **Outcome:** `src/modules/compliance` (objective checks, pure) and `src/modules/candidates` (parse, upsert, job stage handling), plus `clipper candidate upsert | list`. Upserting the same result twice creates each candidate once (the second run refreshes metadata and keeps a passed caption check). The fixture's landscape clip fails `aspect_ratio` and its 9-second clip fails `duration`; a clip with no aspect info gets `manual_review_required`, never `pass`. Stages: clips + a finished stage → `candidates_ready`; a failed stage, or a finished one with no clips → `needs_attention`; nothing yet → `processing` (one status event, not one per poll), then `needs_attention` after 6h. Clips from another project, or a clip ID already stored for another job, are refused. **Pending:** the live half of the check, which needs the task-8 project. No project existed on the account to inspect, so the parser accepts several spellings of each field (snake_case, camelCase, the REST API's `uriForPreview`) and errors on a clip without an ID. Confirm the real field names and stage values on the first live upsert, then narrow the parser.

## 10. Caption validation + `candidate prescreen | set-caption` ✅ done
- `compliance.validateCaption(caption, config)`: exact-match required lines, required tags, disclosures (on their own line when required), hashtag limit.
- `candidate record-edit`: logs a connector `opusclip_edit_clip` call (ops + reason), only for candidates a reviewer marked `needs_edit`; the candidate returns to `awaiting_review`.
- **Done when:** the MW4 caption rules (exact pre-order phrase, `@callofduty`, `#Ad` on its own line) accept a compliant caption and reject each single omission with a specific reason; `record-edit` on a candidate not in `needs_edit` is refused.
- **Outcome:** done-when checks pass. `validateCaption` returns one issue per broken rule (`required_caption_line`, `required_tag`, `disclosure`, `hashtag_limit`, `empty`). It also says when a required phrase is present but not verbatim, and when `#Ad` is present but not on its own line. Tags match as whole handles, case-insensitively. Hashtags inside required phrases and disclosures don't count toward the limit. Disclosures are always required on their own line (the config has no per-campaign switch for it). `set-caption` stores only a valid caption and sets the `caption_compliance` check to `pass`; it's refused once a person has decided (only `awaiting_review` / `needs_edit`). `prescreen` is advisory and changes no status. `record-edit` appends to `edit_log` and moves `needs_edit` → `awaiting_review`. The CLI has no approve/reject/needs-edit/post command (tested).

## 11. Review web app ✅ done
- Server-rendered pages on the existing Fastify app, behind `REVIEWER_TOKEN` for v1: campaigns awaiting confirmation (edit + confirm → `active`), candidate queue with preview video, checks, prescreen notes and caption (approve / needs edit / reject / hold), post recording.
- **Done when:** approve is only reachable through an authenticated request, and every decision writes a `status_events` row with the reviewer as actor.
- **Outcome:** done-when checks pass (`test/web/review.test.ts`, 16 tests), and the whole flow was also driven in Chromium against a real server: sign in, confirm a config, get refused approving a clip with a failed check, approve a compliant one. No horizontal scroll at 390px wide.
  - **Code:** `src/modules/review` holds the human decisions: confirm, request changes, pause/resume, approve / needs edit / reject / hold, record posts. Each refuses a non-`reviewer:` actor itself, on top of `transition()`. `src/web` holds sign-in, the HTML helpers and the routes.
  - **Auth:** sign in with a name + `REVIEWER_TOKEN`. That sets an HMAC-signed, HttpOnly, Secure, SameSite=Strict session cookie (12h), keyed on the token, so rotating the token signs everyone out. Logged actor: `reviewer:<name>`. Failed sign-ins are throttled (10 per 15 min per IP). Anonymous GETs redirect to sign-in; anonymous, forged or expired-session POSTs get 401 with no state change. POSTs must be same-origin (`Origin` and `Sec-Fetch-Site`).
  - **Page safety:** every interpolated value is HTML-escaped. `Content-Security-Policy` allows no scripts at all, and `Referrer-Policy: same-origin` keeps signed preview URLs from leaking. (`no-referrer` made Chromium send `Origin: null` on our own forms, which the browser run caught.)
  - **Rules:** a campaign can be confirmed only from `pending_confirmation`, only if long-form, only with the "checked against the brief" box ticked, and only with a config that passes the schema (so still `autoApprove: false`). The audit row records whether the reviewer edited the draft. Approval needs a caption that passes the caption rules, plus an explicit override with notes if any objective check failed. Needs edit, reject and hold need notes, and hold changes no status. Posts are recorded per platform (re-recording a platform updates its metrics). The first post moves `ready_to_post` → `posted`.
  - **Not in v1:** one shared token, not per-person accounts, so the name is self-declared. A proper sign-in (per-reviewer accounts or an SSO proxy in front of Render) is a Phase 2 item. The session cookie is `Secure`: browsers accept that on `http://localhost`, but anything else needs HTTPS (Render provides it).

## 12. Packaging + notifier ✅ code done · live check pending
- For approved candidates, the operator calls `opusclip_export_clip` (polling `rendering` → `ready`) and records the URL with `candidate record-export`. `clipper package <id>` then streams the export into R2 as `final.mp4` with `caption.txt`, `clip-metadata.json` and `thumbnail.jpg` → `ready_to_post`. It refuses any candidate a human didn't approve.
- Thumbnail: `opusclip_list_clips` returns thumbnail URLs, which resolves the gap found in `c55ad2e`. Verify on the live project.
- `notifier` webhook for `needs_attention`, configs waiting over 24h, and operator reports (`clipper notify`).
- **Done when:** an approved candidate produces the full bundle in R2, packaging a non-approved candidate is refused, and a forced validation failure delivers a real notification.
- **Port:** `src/lib/r2.ts` (streaming multipart upload), `src/modules/export/` and `src/modules/notifier/` from `c55ad2e`.
- **Outcome:** `candidate record-export` (approved clips only, https only), `clipper package <id>`, `clipper notify`, `clipper attention list | notify`, plus signed download links on the review page.
  - **Packaging:** the export streams from OpusClip into R2 through lib-storage's multipart `Upload` and is never buffered whole. Tested against a local S3-compatible server with the real SDK: signed requests, a 12 MB clip in 8 MB parts. The bundle lands under `ready-to-post/<campaign>-<id8>/<clip>-<id8>/`, and `clip-metadata.json` is written last, so its presence means the bundle is complete. The metadata links campaign → source job → OpusClip project/clip → candidate and records the approving reviewer.
  - **Refusals:** anything not `approved`, and even a clip whose status column says approved but has no `reviewer:` approval event. Also a missing export, and a caption that no longer passes the rules.
  - **Failures:** an expired export link fails with a clear message and the clip goes back to `approved`. That's the one human-only move automation may make: back to a decision a person already took (`transition()`). Re-running after a failure starts over; re-running after success returns the existing bundle. A missing thumbnail doesn't block packaging; the metadata says why it's missing.
  - **Notifications:** `attention notify` sends one digest (Slack `{text}` or Discord `{content}`, detected from the URL) of failed/flagged jobs and campaigns plus configs waiting over 24h. It records each item as notified for its current status event only after delivery succeeds, so the same failure isn't re-sent on every run, a new one is, and a failed delivery is retried next run. The playbook runs it at the end of every operator run.
  - **Done-when:** a forced validation failure (Drive sign-in wall) was delivered to a local webhook receiver; bundle and refusal checks pass. **Pending live:** a real R2 bucket and a real Slack/Discord webhook (you provide both), and a real OpusClip export URL from the first live test.

## 13. Operator deployment ⏳ in progress
- Render: web service (review app + `/health`); Supabase Postgres. No worker, no cron.
- **Operator runs are manual only (decided 2026-09-23).** No Claude Code Routine: a person starts each run in a Claude Code session, locally or in the cloud. In the cloud the CLI runs in remote mode through the review app (`CLIPPER_OPERATOR_TOKEN`). The project `.claude/settings.json` (submit guard hook, denied posting/sharing tools, denied Routine-scheduling tools) must be active there.
- **Done when:** a manually started cloud run completes the loop on an empty queue and reports "nothing needs you", and a deliberately unreserved submit in that environment is blocked by the hook (✅ verified 2026-09-23).

## 14. End-to-end on a real campaign
- Pick an LF campaign with a public Drive folder of full-length footage (survey #23 Charlie Berens is a good candidate). Scout → add → onboard → confirm → source → reserve/submit → collect → pre-screen → approve → export → package → Ready to Post. Start with a range-limited submit, then a full video.
- **Done when:** it runs clean twice with no duplicate jobs or candidates on the second pass, and every transition has a `status_events` row.

---

Don't start Phase 2 (richer review UI, webhook-driven sync, performance tracking) until task 14 passes on a real campaign.
