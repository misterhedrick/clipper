# Data Model

PostgreSQL schema. Every table has `id uuid primary key default gen_random_uuid()`, `created_at timestamptz not null default now()`, and `updated_at timestamptz not null default now()` unless noted. Omitted below for brevity — include them on every table.

## `campaigns`

| Column | Type | Notes |
|---|---|---|
| `content_rewards_campaign_id` | text, unique not null | The ID resolved by `campaign-connector`. Primary dedupe key — re-registering the same URL must update, not duplicate, this row. |
| `content_rewards_url` | text not null | As pasted by the user. |
| `title` | text | From campaign metadata. |
| `brand` | text | |
| `platforms` | text[] | e.g. `{tiktok,instagram,youtube}` |
| `guideline_doc_url` | text | |
| `drive_folder_url` | text | |
| `drive_folder_id` | text | Extracted from the URL, used by `footage-enumerator`. |
| `status` | text not null | `discovered \| ingesting \| requirements_drafted \| pending_confirmation \| active \| paused \| archived \| needs_attention` (`needs_attention` is used by `BUILD_PLAN.md` task 4, e.g. `guideline_doc_not_public`) |
| `status_reason` | text | Human-readable reason for the current status, e.g. why the campaign is in `needs_attention`. |
| `config` | jsonb not null default '{}' | The full `CampaignConfig` object — see shape below. |
| `config_confirmed_at` | timestamptz | Null until a human confirms. |
| `config_confirmed_by` | text | Reviewer identifier. |

### `CampaignConfig` shape (stored in `campaigns.config`)

Source of truth: the zod schema in `src/modules/campaign-config/index.ts`. The DB column's type derives from it. Objects are strict, so unknown or misspelled keys are rejected, not dropped.

```ts
type CampaignConfig = {
  clipGeneration: {
    brandTemplateId?: string;                 // OpusClip brand template (opusclip_list_brand_templates)
    aspectRatio: "portrait" | "landscape" | "square" | "four_five";
    minDurationSeconds: number;               // int ≥ 1, ≤ max
    maxDurationSeconds: number;               // int ≤ 600 (OpusClip's bucket limit)
    originalAudioOnly: boolean;
    captionsEnabled: boolean;
  };
  requirements: {
    requiredOverlayAssetIds: string[];   // must be empty: logo/watermark campaigns aren't taken on (validator rejects any)
    requiredOnScreenText: string[];
    requiredCaptionLines: string[];           // exact phrases, checked verbatim
    requiredTags: string[];                   // "@handle"
    disclosureLines: string[];
    maxAdditionalHashtags: number;            // int ≥ 0
  };
  review: {
    requiredChecks: string[];
    autoApprove: false;                       // literal: anything else is rejected
  };
  extraction: {
    fieldConfidence: Partial<Record<ConfigField, "high" | "low">>;  // ConfigField = "clipGeneration.aspectRatio" | …
    unresolvedFields: ConfigField[];          // every field has a confidence or is listed here
    unexpressedRules: string[];               // brief rules the config can't capture, shown to the reviewer
  };
};
```

## `source_jobs`

| Column | Type | Notes |
|---|---|---|
| `campaign_id` | uuid not null, fk → campaigns.id | |
| `drive_file_id` | text not null | |
| `drive_file_name` | text | |
| `size_bytes` | bigint | |
| `md5_checksum` | text | |
| `source_url` | text not null | The public Drive file URL handed to OpusClip. |
| `status` | text not null | `detected \| validating \| validation_failed \| queued \| submitting \| submit_failed \| project_created \| processing \| candidates_ready \| needs_attention \| completed` |
| `status_reason` | text | Human-readable reason for the current status, required when status is a `_failed` or `needs_attention` state. |
| `opusclip_upload_id` | text | Drive videos only: the `upload_id` from OpusClip's upload link once `source upload` has copied the file in. Submitted as `videoUrl` in place of the Drive link; cleared when a failed job is re-validated. |
| `opusclip_project_id` | text | Set as soon as OpusClip confirms creation — before any further processing, so a crash can't orphan a created project untracked. |
| `retry_count` | int not null default 0 | |

**Unique constraint:** `(campaign_id, drive_file_id)` — this is the duplicate-prevention mechanism described in the README. A retry looks up this row before creating anything new.

## `candidate_clips`

| Column | Type | Notes |
|---|---|---|
| `source_job_id` | uuid not null, fk → source_jobs.id | |
| `opusclip_clip_id` | text not null unique | Format `{project_id}.{curation_id}` per OpusClip's API. |
| `title` | text | |
| `duration_ms` | int | |
| `preview_url` | text | OpusClip `uriForPreview`. |
| `export_url` | text | OpusClip `uriForExport`, null until export completes. |
| `hashtags` | text | |
| `status` | text not null | `generated \| checking \| awaiting_review \| needs_edit \| approved \| exporting \| ready_to_post \| posted \| rejected \| archived` |
| `check_results` | jsonb | `{ [checkName]: "pass" \| "fail" \| "manual_review_required" }` |

## `status_events`

Append-only audit log. Every status transition on `campaigns`, `source_jobs`, or `candidate_clips` writes a row here — this is what satisfies the README's "every status change should include timestamp, actor, reason, related IDs" requirement. Application code should never update a `status` column without also inserting here in the same transaction.

| Column | Type | Notes |
|---|---|---|
| `entity_type` | text not null | `campaign \| source_job \| candidate_clip` |
| `entity_id` | uuid not null | |
| `from_status` | text | |
| `to_status` | text not null | |
| `actor` | text not null | `system` or a reviewer identifier. |
| `reason` | text | |
| `error_details` | jsonb | |

## `posts`

Manual-posting tracking (README § "Post manually in version one").

| Column | Type | Notes |
|---|---|---|
| `candidate_clip_id` | uuid not null, fk → candidate_clips.id | |
| `platform` | text not null | `tiktok \| instagram \| youtube` |
| `url` | text | |
| `posted_at` | timestamptz | |
| `views` | int | |
| `likes` | int | |
| `engagement_rate` | numeric | |
| `earnings` | numeric | |
| `notes` | text | |

## v3 changes (migration `0003_snapshot_and_audit_log`)

- `campaigns.cr_snapshot jsonb`, `cr_snapshot_at`: the full `campaign-connector` result at `campaign add` time (payouts, budget, reference materials, Content Rewards' own status). The operator reads it while scouting and onboarding.
- `audit_log` (`entity_type`, `entity_id`, `action`, `actor`, `details jsonb`): the audit trail for writes that aren't status changes. `entity_type` is `campaign | source_job | candidate_clip | footage_source | credits`.

## Status changes: `transition()`

`src/db/transition.ts` is the only code that writes a `status` column. A static test fails the build if any other file does. Each call:
- locks the row (`SELECT … FOR UPDATE`), so concurrent transitions serialize;
- checks the change is in that entity's allowed-transition table (e.g. a source job can't jump from `detected` to `completed`);
- refuses **human-only** targets unless the actor is `reviewer:<identity>`: campaign → `active`; candidate → `approved`, `needs_edit`, `rejected`, `posted`. The operator (`claude-operator`) and `system` can never make these moves, whatever calls them. The one exception is a revert to a decision a person already made: a failed packaging run goes `exporting` → `approved` (and `exporting` is only reachable from `approved`);
- updates the row (and `status_reason` where the table has it) and inserts the `status_events` row in one transaction.

## Constraints enforced in the database

- Every `status` column (and `status_events.entity_type`, `posts.platform`) has a `CHECK` constraint limiting it to the values listed above, so a typo in application code fails loudly.
- `source_jobs`: `status_reason` must be non-null when `status` is `validation_failed`, `submit_failed`, or `needs_attention`.

The schema source of truth is `src/db/schema.ts` (Drizzle); migrations in `src/db/migrations/` are generated from it with `npm run db:generate`, never hand-edited.

## Indexes to create explicitly

- `source_jobs (campaign_id, drive_file_id)` — unique, dedupe.
- `source_jobs (status)` — the job queue and Needs Attention alerts scan by status.
- `candidate_clips (status)` — the review queue scans by status.
- `campaigns (status)` — the enumerator polls only `active` campaigns.
- `status_events (entity_type, entity_id)` — audit lookups per entity.

## v2 changes (BUILD_PLAN task 3, migrated in `0001_drop_drive_columns` + `0002_schema_v2`)

Two migrations rather than one: drizzle-kit prompts interactively when a table both loses and gains columns in one step. The v2 migration adds `NOT NULL` columns to `source_jobs` without defaults. That's safe only because no deployed database holds rows yet; after the first real deploy, schema changes must include backfills.

These come from the Claude-operator design (`ARCHITECTURE.md`) and the finding that footage comes from many hosts, not just Drive (`CAMPAIGN_SURVEY.md`).

### `campaigns`: add

| Column | Type | Notes |
|---|---|---|
| `campaign_type` | text | `lf \| ugc \| music \| slideshow \| unclear`, set by `campaign classify`. Only `lf` campaigns can be confirmed. |
| `campaign_type_reason` | text | |
| `max_daily_credits` | int | Per-campaign cap. Null = only the global budget applies. |

Drop `drive_folder_url` / `drive_folder_id`; footage locations move to `footage_sources`.

### `footage_sources` (new)

One row per footage *location* registered for a campaign (a Drive folder, a YouTube channel, a single file link).

| Column | Type | Notes |
|---|---|---|
| `campaign_id` | uuid not null, fk | |
| `kind` | text not null | `gdrive_folder \| gdrive_file \| youtube_channel \| youtube_video \| s3_mp4 \| dropbox \| frameio \| loom \| vimeo \| twitch` |
| `url` | text not null | As found in the brief |
| `label` | text | e.g. "Raw to edit, full podcast episodes" |
| `added_by` | text not null | `claude-operator` or a reviewer |
| `reason` | text not null | Where in the brief, and why it's footage |
| `last_listed_at` | timestamptz | When `list-url` last expanded it |

Unique: `(campaign_id, url)`.

### `source_jobs`: change

- Replace `drive_file_id` with `source_key text not null` (e.g. `gdrive:{fileId}`, `youtube:{videoId}`; see `ARCHITECTURE.md` § "Footage source kinds") and `source_kind text not null`.
- Add `footage_source_id uuid` fk (nullable: a file can be selected directly).
- Add `decision text not null`: `selected \| skipped`, with `decision_reason text not null` and `decided_by text not null`. Skipped files get a row too, so later runs don't re-evaluate them. A skipped row sits in the terminal status **`skipped`** (added to the status vocabulary). A CHECK ties `decision = 'skipped'` to `status = 'skipped'` both ways.
- Rename `drive_file_name` → `source_name`. Add `source_path` (folder path within the source).
- Add `submit_params jsonb`: the exact parameters `clipper source reserve` issued for the connector call. The submit guard hook compares the real call against this.
- Add `opusclip_stage text`: last project stage seen via `opusclip_list_clips`.
- Unique: `(campaign_id, source_key)` replaces `(campaign_id, drive_file_id)`.

### `candidate_clips`: add

| Column | Type | Notes |
|---|---|---|
| `opusclip_score` | numeric | |
| `opusclip_sub_scores` | jsonb | hook / coherence / connection / trend, when present |
| `thumbnail_url` | text | From `opusclip_list_clips` |
| `description` | text | From OpusClip |
| `prescreen_verdict` | text | `recommend \| hold \| reject`. Advisory only. |
| `prescreen_notes` | text | |
| `prescreened_at` | timestamptz | |
| `caption` | text | Validated against campaign requirements before it's stored |
| `review_notes` | text | Reviewer notes from the web app (what to fix when `needs_edit`) |
| `edit_log` | jsonb | Connector edits applied: `[{ops, reason, at}]` |

### v4 changes (migration `0004_package_location`, BUILD_PLAN task 12)

`candidate_clips`: add `package_key text` (the R2 prefix `clipper package` wrote the Ready-to-Post bundle under, e.g. `ready-to-post/<campaign>-<id8>/<clip>-<id8>/`) and `packaged_at timestamptz`.

### `credit_ledger` (new)

One row per credit reservation made by `clipper source reserve`.

| Column | Type | Notes |
|---|---|---|
| `source_job_id` | uuid not null, fk | |
| `campaign_id` | uuid not null, fk | |
| `credits_reserved` | int not null | Estimate: range length, `--estimated-minutes`, or the 90-minute default (≈1 credit/min) |
| `status` | text not null | `open \| consumed \| released`. `open` on reserve, `consumed` on `record-project`, `released` on `record-failure` |
| `reserved_at` | timestamptz not null | Daily budget sums `open` + `consumed` rows reserved today (UTC) |
| `closed_at` | timestamptz | |

Partial unique index on `(source_job_id) where status = 'open'`: at most one open reservation per job. The budget check and insert run in one transaction holding a transaction-scoped advisory lock (`pg_advisory_xact_lock`) on the budget, so two concurrent reservations can't both pass. That's task 8.

### `opus_usage_snapshots` (new)

| Column | Type | Notes |
|---|---|---|
| `used` | int not null | `monthly.used` from `opusclip_get_usage` |
| `monthly_limit` | int not null | `monthly.limit` (900 on Pro as of 2026-09-22). Not `limit`, which is a reserved word |
| `reset_at` | timestamptz not null | |
| `recorded_by` | text not null | |

Written by `clipper credits reconcile`. `clipper credits` compares the ledger with the latest snapshot, so drift between our estimates and OpusClip's real billing is visible.
