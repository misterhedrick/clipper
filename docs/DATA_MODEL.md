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

```ts
type CampaignConfig = {
  clipGeneration: {
    brandTemplateId?: string;
    aspectRatio: "portrait" | "landscape" | "square";
    minDurationSeconds: number;
    maxDurationSeconds: number;
    originalAudioOnly: boolean;
    captionsEnabled: boolean;
  };
  requirements: {
    requiredOverlayAssetIds: string[];
    requiredOnScreenText: string[];
    requiredCaptionLines: string[];
    requiredTags: string[];
    disclosureLines: string[];
    maxAdditionalHashtags: number;
  };
  review: {
    requiredChecks: string[]; // e.g. ["visual_quality", "campaign_branding", "caption_compliance"]
    autoApprove: false; // literal type — this must never be true in v1
  };
  extraction: {
    // one entry per field above that the requirements-extractor populated
    fieldConfidence: Record<string, "high" | "low">;
    unresolvedFields: string[];
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
