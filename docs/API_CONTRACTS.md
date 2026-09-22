# External API Contracts

Everything in this document was verified by direct inspection during the planning session (fetching live pages/docs), not from official written specs for the Content Rewards parts — treat those as **reverse-engineered and subject to change without notice**. Isolate them behind `campaign-connector` per `ARCHITECTURE.md` so a breakage is a one-file fix. The OpusClip section is from their published API docs and is stable.

---

## Content Rewards (unofficial — no public API)

### Resolving a campaign ID from a shared URL

Campaign cards on `https://contentrewards.com/discover` link via client-side routing, not plain `<a href>` tags, so the ID has to be pulled from the discover page's embedded data (see below) or via this redirect trick:

```
GET https://contentrewards.com/campaigns/{campaignId}
→ 308 redirect to https://contentrewards.com/discover/{campaignId}
```

If a user pastes a `/discover/{campaignId}` URL directly, the ID is just the path segment — no extra request needed.

### Discover listing page embedded campaign data (not used by `campaign-connector`)

`GET https://contentrewards.com/discover` returns server-rendered HTML with campaign objects embedded as escaped JSON inside the page payload (not a clean `<script id="__NEXT_DATA__">` block — it's further inside a streamed RSC payload). Observed fields per campaign object:

```jsonc
{
  "id": "24ad920b-d24f-479e-9cef-f22182e4a0c0",
  "title": "Call of Duty - Modern Warfare 4 Multiplayer Beta Gameplay Clipping",
  "description": "Post Modern Warfare 4 Multiplayer Beta gameplay to TikTok, Instagram Reels, and YouTube Shorts. Edit the source footage into polished clips, do not post it as a raw reel.",
  "organizationExperienceId": "exp_zeADOv9rOOKk2x",
  "platforms": ["instagram", "tiktok", "youtube"],
  "isVerified": true,
  "requiresApplication": false,
  "type": "cpm",
  "payoutSortRaw": 1.75,
  "ratePer1kLabel": "$$1.75",
  "availableBudgetRaw": 65000, // total budget, name inferred — confirm on next scrape
  "progressPercentage": 66.69,
  "submissionCountRaw": 4348,
  "creatorCountRaw": 962,
  "fundedAgo": "3w",
  "thumbnail": "https://content-rewards-production-publicassetsbucket-....s3.us-east-1.amazonaws.com/.../thumbnails/{id}.jpg",
  "createdAtMs": 1787769531000
}
```

**Extraction approach:** fetch the raw HTML, regex/parse out the JSON object containing the target campaign's `id`, rather than trying to fully parse the RSC stream format. This is brittle by nature — write a test that fetches a known campaign ID and asserts the expected fields parse, so a Content Rewards frontend change is caught immediately rather than silently producing empty campaigns.

### Individual campaign page (verified 2026-09-22 — this is what `campaign-connector` parses)

`GET https://contentrewards.com/discover/{campaignId}` is a Next.js App Router page. Its data is streamed as `self.__next_f.push([1, "<chunk>"])` script tags; concatenating the string chunks gives the RSC payload, in which the campaign appears as a plain JSON object (currently the `card` prop of a component). `campaign-connector` locates it by finding the object whose **own top-level** `id` equals the campaign ID — the ID also appears in unrelated props (e.g. `{"campaignId": ...}` on the join button), so a bare substring match is not enough. It does not depend on the `card` key name.

Observed shape (irrelevant fields omitted; `metrics` holds leaderboard data about other creators and is ignored):

```jsonc
{
  "id": "24ad920b-d24f-479e-9cef-f22182e4a0c0",
  "name": "Call of Duty - Modern Warfare 4 Multiplayer Beta Gameplay Clipping",  // not "title"
  "description": "Post Modern Warfare 4 Multiplayer Beta gameplay to ...",
  "organizationName": "Clipping Culture",        // → campaigns.brand
  "organizationVerified": true,
  "platforms": ["instagram", "tiktok", "youtube"],
  "status": "paused",                              // Content Rewards' own status, e.g. active/paused
  "private": false,
  "requiresApplication": false,
  "payoutType": "cpm",
  "budgetCents": 7894530,
  "payouts": [                                      // all money is integer cents
    { "platform": "tiktok",    "payoutType": "cpm", "rateCents": 175, "minPayoutCents": 350, "maxPayoutCents": 250000 },
    { "platform": "instagram", "payoutType": "cpm", "rateCents": 150, "minPayoutCents": 450, "maxPayoutCents": 250000 },
    { "platform": "youtube",   "payoutType": "cpm", "rateCents": 175, "minPayoutCents": 525, "maxPayoutCents": 250000 }
  ],
  "referenceMaterials": [                           // the only place external links appear
    { "type": "brandAsset", "mediaType": "external",
      "url": "https://docs.google.com/document/d/{docId}/edit?usp=sharing" }
  ],
  "createdAt": "2026-08-26T18:38:51.000Z",
  "updatedAt": "2026-09-22T22:46:23.000Z"
}
```

There are no dedicated `guidelineDocUrl` / `driveFolderUrl` fields. The connector takes the first `referenceMaterials` URL matching `docs.google.com/document/d/{id}` as the guideline doc and the first matching `drive.google.com/drive/folders/{id}` as the footage folder; either may be null.

**The footage folder is not necessarily a Drive folder, and not necessarily on the campaign page.** For the MW4 reference campaign, `referenceMaterials` contains only the guideline doc; the doc itself says `Content Folder: https://app.mediasilo.com/review/...` — footage is hosted on MediaSilo, not Google Drive. How footage sources other than a public Drive folder are handled is an open question for `footage-enumerator` (BUILD_PLAN task 6).

### Guideline doc (Google Docs)

`brief-reader` fetches the doc as HTML, not plain text. The `txt` export drops hyperlinks, and footage folders are often linked from link text (verified in the survey):

```
GET https://docs.google.com/document/d/{docId}/export?format=html
```

Hyperlinks come wrapped as `https://www.google.com/url?q=<real url>&...`; unwrap the `q` parameter. A non-public doc returns **401** (observed in the survey); a redirect to `accounts.google.com` means the same thing.

This only works if the doc is actually public ("anyone with the link can view"). If it returns 401 or redirects to sign-in instead of the document, treat that as `campaign.status = needs_attention` with reason `guideline_doc_not_public` — per README, never attempt to authenticate around this.

### Footage folder (Google Drive)

**Keyless listing (preferred, verified 2026-09-22):** `GET https://drive.google.com/embeddedfolderview?id={folderId}` returns HTML listing the folder's files and subfolders (`flip-entry` elements with titles and IDs) for any link-shared folder, with no API key. Recurse into subfolders. The Drive API option below is a fallback.

Two viable approaches, in preference order:

1. **Drive API v3 with a plain API key** (no OAuth): `GET https://www.googleapis.com/drive/v3/files?q='{folderId}'+in+parents&key={API_KEY}&fields=files(id,name,size,md5Checksum,mimeType,createdTime)`. Works for folders shared "anyone with the link can view." Requires only a Drive API key (Google Cloud project, no service account, no user consent) — the simplest option given source data is public by design.
2. **Fallback scrape** of the public folder listing page if the API key approach ever hits a permission edge case — slower and brittle, avoid unless (1) fails in practice.

Use option 1. Each returned file's `id` is the `drive_file_id` used for dedupe in `DATA_MODEL.md`, and `md5Checksum` is reliably present for binary video files.

**Direct source URL to hand OpusClip:** `https://drive.google.com/file/d/{fileId}/view?usp=sharing` (OpusClip's documented Google Drive support consumes this share-link form, not a raw download URL).

---

## OpusClip connector (MCP): how the operator uses OpusClip

Verified 2026-09-22 on the connected account: plan **PRO**, `has_api_access: true`, monthly cap **900 credits** (`enforced: false`, so our ledger is the real limit), **10** concurrent projects. Brand templates: `Preset template 1` (default, portrait) and `MW4` (portrait). No social accounts connected.

Tools the operator uses (names as exposed in Claude Code: `mcp__OpusClip__<tool>`):

| Tool | Used for | Notes |
|---|---|---|
| `opusclip_get_usage` | headroom before `reserve`, `credits reconcile` | `monthly {used, limit, remaining, reset_at}`, `concurrent {used, limit}` |
| `opusclip_submit_project` | create a project | **Only** with `submitParams` from `clipper source reserve`; guarded by a PreToolUse hook. Params: `videoUrl`, `aspectRatio` (`portrait\|square\|landscape\|four_five`), `brandTemplateId`, `clipDurationsSec` (`[[min,max],…]`), `rangeStart`/`rangeEnd` (seconds; only the range is billed), `title`, `customPrompt`, `genre`, `enableCaption`, `sourceLang` |
| `opusclip_list_projects` | crash recovery: find `clipper:<jobId>` | |
| `opusclip_list_clips` | collect candidates | rank, score, sub-scores, title, description, hashtags, duration, preview + **thumbnail** URLs, and the project `stage` (empty list + in-progress stage = not ready yet) |
| `opusclip_describe_clip` | pre-screen | the clip's transcript, keywords, layout, `render_pending` |
| `opusclip_get_transcript` | pre-screen, source-level | per-word timings for the whole source |
| `opusclip_analyze_video` | layout-dependent brief rules | async: start, then poll with `taskId` alone |
| `opusclip_edit_clip` | reviewer-requested fixes | `dryRun` first; ops include `delete_phrase`, `replace_phrase`, `trim_section`, `remove_pauses`, `remove_filler_words`, `add_text_overlay`, `set_style` |
| `opusclip_export_clip` | HD URL for approved clips | `rendering` → call again; `ready` → `export_url`; `unavailable` is final |
| `opusclip_preview_clips` | show clips in chat | |
| `opusclip_list_brand_templates` | config drafting | |
| `opusclip_create_upload_link` | footage from unsupported hosts, supplied by a person | returns a signed upload URL; pass the `upload_id` as `videoUrl` |

**Denied in `.claude/settings.json`:** `opusclip_create_post_task`, `opusclip_schedule_publish`, `opusclip_unschedule_publish`, `opusclip_share_project`. v1 doesn't post or share through OpusClip.

The raw HTTP API below is kept for reference and as the fallback for a cron poller (`ARCHITECTURE.md` § Runtime shape). The operator doesn't call it.

## OpusClip API (reference / fallback)

Base URL: `https://api.opus.pro`. Auth: `Authorization: Bearer {OPUSCLIP_API_KEY}` header on every request; add `x-opus-org-id` if the account belongs to multiple orgs.

**Limits:** max video duration 10 hours, max file size 30 GB, rate limit 30 requests/minute per API key, 10-credit minimum consumed per project created.

### Create a clip project

```
POST /api/clip-projects
Content-Type: application/json
Authorization: Bearer {API_KEY}

{
  "videoUrl": "https://drive.google.com/file/d/{fileId}/view?usp=sharing",  // required
  "brandTemplateId": "preset-fancy-Karaoke",                                 // optional
  "curationPref": {
    "durationRange": { "min": 10, "max": 45 },
    "keywords": [],
    "genre": null
  },
  "renderPref": {
    "aspectRatio": "portrait",
    "captions": false
  },
  "importPreference": { "language": "en" },
  "conclusionActions": [
    { "type": "webhook", "url": "https://<our-host>/webhooks/opusclip" }
  ],
  "uploadedVideoAttr": { "title": "source_job:{sourceJobId}" }
}
```

Response includes a project ID — persist it onto `source_jobs.opusclip_project_id` immediately on receipt, before any other processing (see `ARCHITECTURE.md` § project-creator).

**Failure handling:** a non-2xx here or a network error is retryable (exponential backoff) unless the error body indicates a permanent problem (invalid/unsupported URL, insufficient credits) — those go straight to `submit_failed` / `needs_attention`, not a retry loop. OpusClip's docs don't enumerate exact error codes; log the full response body on failure so the retry classifier can be tuned from real examples during Phase 1.

### Retrieve generated clips

```
GET /api/exportable-clips?q=findByProjectId&projectId={projectId}&pageNum=1&pageSize=50
Authorization: Bearer {API_KEY}
```

Response: array of clip objects —

```jsonc
{
  "id": "{projectId}.{curationId}",
  "projectId": "...",
  "curationId": "...",
  "uriForPreview": "https://storage.googleapis.com/.../preview.mp4",
  "uriForExport": "https://storage.googleapis.com/.../export.mp4", // null until export finishes
  "durationMs": 32000,
  "title": "...",
  "description": "...",
  "hashtags": "#modernwarfare #cod",
  "renderPref": { /* echoes aspect ratio, captions, etc. */ },
  "createdAt": "2026-...",
  "updatedAt": "2026-..."
}
```

Poll this on a backoff schedule per `source_job` while status is `processing` (e.g. every 30s for the first 5 minutes, then every 2 minutes, capped at some max wait before flagging `needs_attention`). Map results into `candidate_clips` rows, keyed by the unique `id`.

### Webhook (`conclusionActions`)

OpusClip supports a webhook callback configured via `conclusionActions` in the create-project call, but the exact payload shape and delivery guarantees are not fully documented. Build the receiver defensively:

- Verify whatever signature/secret mechanism OpusClip provides (confirm exact header/scheme during implementation — test against a real account) before trusting the payload.
- Treat the webhook purely as a trigger to run the same `GET /api/exportable-clips` poll immediately, rather than trusting fields inside the webhook body directly. This means correctness never depends on the undocumented payload shape — the webhook is just a low-latency nudge, and polling remains the source of truth (already required as a fallback in `ARCHITECTURE.md`).

### Google Drive as an ingestion source — the one operational risk

OpusClip fetches the video from the `videoUrl` server-side. Google Drive applies an anti-abuse download quota to anonymous/public links; if a campaign's footage file has had heavy traffic, OpusClip's fetch can be transiently rejected by Drive. Treat this as retryable (see README § Retry policy) — do not treat repeated failures on the same file as a permanent error until several retries with backoff have been exhausted.
