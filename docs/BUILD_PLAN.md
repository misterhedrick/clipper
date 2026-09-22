# Build Plan

Ordered task list for Phase 1 (README § Recommended Build Phases). Each task lists its dependencies and a concrete "done when" check — build and verify in this order; later tasks assume earlier ones work.

Phases 2-4 are intentionally not broken down to this granularity yet — do that once Phase 1 is live and real campaign data has been run through it, since Phase 2+ priorities should be informed by what Phase 1 actually surfaces as painful.

## 0. Project scaffold ✅ done
- Repo layout per `ARCHITECTURE.md`.
- `config.ts` loads and validates required env vars at boot, fails fast (not at first use) if any are missing: `DATABASE_URL`, `OPUSCLIP_API_KEY`, `GOOGLE_API_KEY` (Drive), `ANTHROPIC_API_KEY` (requirements extraction), `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` (export storage), `NOTIFY_WEBHOOK_URL` (or email creds — pick one channel for v1).
- **Done when:** app boots locally against a local Postgres with no code beyond config loading and a health-check route.

## 1. Database ✅ done
- Implement schema from `DATA_MODEL.md` as migrations.
- **Done when:** migrations run clean on an empty DB, and a manual insert/select round-trips through each table including the unique `(campaign_id, drive_file_id)` constraint (write a test that inserts a duplicate and asserts it's rejected).

## 2. `campaign-connector`
- Implement URL → campaign ID resolution (direct `/discover/{id}` parse, and the `/campaigns/{id}` → 308 redirect fallback).
- Implement discover-page JSON extraction per `API_CONTRACTS.md`.
- Implement individual campaign page fetch for `guidelineDocUrl` / `driveFolderUrl`.
- **Done when:** given the real MW4 campaign URL used during planning (`https://contentrewards.com/discover/24ad920b-d24f-479e-9cef-f22182e4a0c0`), the module returns title, platforms, payout data, and both linked URLs. Write this as an integration test (network-dependent, can be skipped in CI but must be runnable manually) — if Content Rewards changes markup, this is the test that catches it.

## 3. Campaign registration flow (minimal `review-api`)
- One endpoint: `POST /campaigns { contentRewardsUrl }` → runs `campaign-connector`, inserts a `campaigns` row with `status = ingesting`, then `discovered`/`requirements_drafted` as steps complete.
- **Done when:** posting a real campaign URL produces a `campaigns` row with metadata populated and `guideline_doc_url`/`drive_folder_url` set.

## 4. `requirements-extractor`
- Fetch guideline doc text (`export?format=txt`); if it 302s to a Google login page, set campaign status to `needs_attention` with reason `guideline_doc_not_public` and stop — do not proceed.
- One Claude API call with a strict JSON schema matching `CampaignConfig.requirements` + `clipGeneration`, asking the model to also emit a per-field confidence and a list of fields it couldn't find.
- Write the result into `campaigns.config`, set `status = pending_confirmation`.
- **Done when:** run against a real (public) guideline doc, the output has every schema field present (null where genuinely unknown) and low-confidence fields flagged rather than guessed.

## 5. Confirmation endpoint
- `POST /campaigns/{id}/confirm { config, confirmedBy }` — accepts a human-edited version of the draft config, sets `status = active`, `config_confirmed_at`, `config_confirmed_by`.
- Reject confirmation if `review.autoApprove` is anything but `false` — this is a hard invariant per README non-goals, enforce it in code, not just convention.
- **Done when:** a campaign only reaches `active` through this endpoint; there is no code path that sets `status = active` any other way (grep the codebase for `'active'` assignments as a review step).

## 6. `footage-enumerator`
- List files in the campaign's Drive folder via Drive API v3 + API key.
- Diff against existing `source_jobs.drive_file_id` for the campaign; insert one `source_jobs` row (`status = detected`) per unseen file.
- Run on a poll interval (job in the queue, not a cron hack) — only for campaigns with `status = active`.
- **Done when:** running it twice against the same folder produces zero duplicate `source_jobs` rows the second time; adding a new file to the test folder and re-running produces exactly one new row.

## 7. Source validation
- Implement the checklist from README § "Validate the source": file type, campaign active, not a dup (already covered by #6's constraint), size/duration limits, pre-flight reachability (HEAD request on the Drive share URL).
- On failure: `status = validation_failed`, `status_reason` set, `notifier` fires.
- **Done when:** an oversized or wrong-extension file is rejected with a specific reason; a valid file proceeds to `queued`.

## 8. `project-creator`
- Submit `POST /api/clip-projects` per `API_CONTRACTS.md`, using the campaign's confirmed `config` to fill `brandTemplateId`, `curationPref`, `renderPref`.
- Persist `opusclip_project_id` immediately on a successful response, before returning from the handler.
- Classify failures per the retry table in README § Retry policy; permanent failures go to `submit_failed` + `needs_attention`.
- **Done when:** a real (small, short) public test video submits successfully and `source_jobs.opusclip_project_id` is populated; a deliberately-broken URL produces a classified failure, not an unhandled exception.

## 9. `project-monitor`
- Polling worker: for every `source_job` with `status = project_created` or `processing`, call `GET /api/exportable-clips`, upsert into `candidate_clips`.
- Webhook receiver route: on receipt, trigger the same poll for the referenced project (don't trust webhook body fields directly — see `API_CONTRACTS.md`).
- **Done when:** candidates appear in `candidate_clips` for a real submitted project, purely from polling (test with the webhook disabled first, to prove the fallback path works standalone).

## 10. `compliance-service`
- Implement the objective checks from README § "Run automated checks" against `candidate_clips` + the campaign's `config`.
- Write results into `candidate_clips.check_results`; anything not objectively verifiable is `manual_review_required`, never `pass`.
- **Done when:** a clip with wrong aspect ratio is flagged `fail` on that check; a clip meeting all objective criteria but with unverifiable overlay requirements shows `manual_review_required` for that check, not `pass`.

## 11. Review queue + decision endpoints
- `GET /candidates?status=awaiting_review` (filterable by campaign).
- `POST /candidates/{id}/decision { decision: approve|needs_edit|reject|hold, reviewer, notes }`.
- Every decision writes a `status_events` row.
- **Done when:** approving a candidate moves it to `approved` and triggers task #12; rejecting records a reason and the clip never resurfaces in the queue.

## 12. Export + Ready to Post packaging
- On approval: fetch `uriForExport` (poll if not yet populated), write the package structure from README § "Prepare approved clips" to the platform's own storage, create the caption file from `config.requirements`.
- **Done when:** an approved candidate produces a `final.mp4` + `caption.txt` + `clip-metadata.json` + `thumbnail.jpg` bundle and a `posts`-ready tracker entry.

## 13. `notifier`
- Wire actual delivery (email or Slack — pick one) for: any `needs_attention` transition, and campaigns sitting in `pending_confirmation` past a configurable threshold (e.g. 24h).
- **Done when:** triggering a validation failure in a test actually produces a delivered notification, not just a log line.

## 14. End-to-end smoke test
- Register a real campaign → confirm requirements → let a real footage file flow through to `ready_to_post` → verify every table has consistent, linked rows and every transition has a `status_events` entry.
- **Done when:** this runs clean twice in a row against the same campaign without creating any duplicate `source_jobs` or `candidate_clips` rows on the second run (idempotency check).

---

Do not start Phase 2 work (dashboard, webhook-first monitoring, richer compliance) until task 14 passes against a real Content Rewards campaign end to end.
