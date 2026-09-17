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

### Discover page embedded campaign data

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

### Individual campaign page

`GET https://contentrewards.com/discover/{campaignId}` — **verified against two live campaigns during implementation.** The reliable extraction point is not the React Server Component payload (which repeats keys like `id`/`title` across unrelated nested objects and is genuinely hard to parse correctly) but the page's own `<script type="application/ld+json">` blocks — schema.org structured data meant for external consumption, and well-formed JSON by construction. Each page embeds several `ld+json` blocks (site `Organization`, `WebSite`); the campaign's own data is the one with `"@type":"Product"`:

```jsonc
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "Call of Duty - Modern Warfare 4 Multiplayer Beta Gameplay Clipping",
  "description": "Post Modern Warfare 4 Multiplayer Beta gameplay to TikTok, Instagram Reels, and YouTube Shorts. Edit the source footage into polished clips, do not post it as a raw reel.",
  "brand": { "@type": "Organization", "name": "Clipping Culture" },
  "image": ["https://content-rewards-production-publicassetsbucket-....s3.us-east-1.amazonaws.com/.../thumbnails/{id}.jpg"],
  "url": "https://contentrewards.com/discover/{campaignId}"
}
```

Payout/platform fields are only in the RSC payload, not the `ld+json` block, but are simple enough to pull with a direct regex on the unescaped page text rather than full object parsing:

```jsonc
{
  "platforms": ["instagram", "tiktok", "youtube"],
  "cpmMinRateCents": 150,
  "cpmMaxRateCents": 175,
  "budgetCents": 10500000
}
```

`guidelineDocUrl` and `driveFolderUrl` are found by a plain substring regex for `docs.google.com` / `drive.google.com` anywhere on the page — there's no clean field name for either. **Not every campaign links a Drive folder directly on its page** — confirmed by testing two real campaigns: ForgeGUI Clipping exposes one, MW4 Clipping does not (its raw footage source, if any, isn't on the public page at all). Treat a missing `driveFolderUrl` as a legitimate outcome, not a parse failure — such a campaign may need its footage sourced some other way (inside the guideline doc, or not automatable at all), which `footage-enumerator` and campaign registration should surface clearly rather than silently produce zero source jobs forever.

Implementation lives in `src/modules/campaign-connector/parseDiscoverPageHtml.ts`, kept isolated per the module boundary in `ARCHITECTURE.md` so a Content Rewards markup change only breaks one file.

### Guideline doc (Google Docs)

Fetch the plain text of the doc for the `requirements-extractor`:

```
GET https://docs.google.com/document/d/{docId}/export?format=txt
```

This only works if the doc is actually public ("anyone with the link can view"). If it 302s to a Google sign-in page instead of returning `text/plain`, treat that as `campaign.status = needs_attention` with reason `guideline_doc_not_public` — per README, never attempt to authenticate around this. **Verified against both real campaign docs during implementation — this endpoint returns the full plain text directly with no login wall**, even though the interactive `/edit` UI (what a browser or a naive page-fetch would hit) shows a sign-in prompt for the same doc. Always use the `/export?format=txt` endpoint, never the `/edit` URL, for exactly this reason.

### Important discovery: footage isn't always on Google Drive

Reading the actual MW4 guideline doc during implementation surfaced something the original plan didn't account for: **the real source-footage link lives inside the guideline doc's body text, not necessarily on the discover page**, and it isn't always Google Drive. The MW4 doc reads:

```
Content Folder: https://app.mediasilo.com/review/6a88a6c15a183a21eeeae9e6
Do NOT use footage from any source outside the official content folders above.
```

That's [MediaSilo](https://www.mediasilo.com/), a video review platform — not Drive. ForgeGUI, by contrast, links its footage folder directly on the discover page as an actual `drive.google.com` URL (see above). So there are at least two real patterns in the wild:

1. **Drive folder linked directly on the campaign page** (`driveFolderUrl` from `campaign-connector`) — ForgeGUI.
2. **A "Content Folder" link inside the guideline doc body**, which may point at Drive, MediaSilo, or something else entirely — MW4.

**Implementation implication:** `requirements-extractor`, while it already has the doc text in hand, should also scan it for a footage source link (regex for a `Content Folder:` line, or any `drive.google.com` / other known review-platform domain) and record both the URL and a `footageSourceType` (`google_drive` | `mediasilo` | `unknown`). `footage-enumerator` (see below) only actually knows how to enumerate `google_drive` sources in Phase 1. A campaign whose only footage link resolves to `mediasilo` or `unknown` should go to `needs_attention` with a clear reason (e.g. `footage_source_not_supported: mediasilo`) rather than silently producing zero source jobs forever, or — worse — guessing that it's a Drive link when it isn't. Supporting MediaSilo (or others) as a second footage source is real, scoped follow-up work, not something to fake now.

### Footage folder (Google Drive)

Two viable approaches, in preference order:

1. **Drive API v3 with a plain API key** (no OAuth): `GET https://www.googleapis.com/drive/v3/files?q='{folderId}'+in+parents&key={API_KEY}&fields=files(id,name,size,md5Checksum,mimeType,createdTime)`. Works for folders shared "anyone with the link can view." Requires only a Drive API key (Google Cloud project, no service account, no user consent) — the simplest option given source data is public by design.
2. **Fallback scrape** of the public folder listing page if the API key approach ever hits a permission edge case — slower and brittle, avoid unless (1) fails in practice.

Use option 1. Each returned file's `id` is the `drive_file_id` used for dedupe in `DATA_MODEL.md`, and `md5Checksum` is reliably present for binary video files.

**Direct source URL to hand OpusClip:** `https://drive.google.com/file/d/{fileId}/view?usp=sharing` (OpusClip's documented Google Drive support consumes this share-link form, not a raw download URL).

---

## OpusClip API

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
