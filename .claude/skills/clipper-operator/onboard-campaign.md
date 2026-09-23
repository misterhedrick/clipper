# Onboard a campaign (brief → proposed config)

Goal: turn a freeform brief into a validated campaign config for a person to confirm once. Applies to campaigns in `discovered` that are classified `lf`.

## 1. Read everything the brief points to

`clipper campaign brief <id>` returns the doc text (each link shown inline as `words <url>`), every hyperlink in it, `linkedDocs` to read next, and the campaign's `referenceMaterials`. Also read:
- every entry in `linkedDocs` (sub-briefs: caption rules, content guides) with `clipper campaign brief <id> --doc <url>`;
- nothing that needs sign-in. A Notion or other page that holds the real rules but can't be read is a `campaign flag` with the link.

## 2. Draft the config

Write `config.json` matching the `CampaignConfig` schema (`docs/DATA_MODEL.md`). The CLI validates it. Guidance per field:

| Field | Where it usually is | Notes |
|---|---|---|
| `clipGeneration.aspectRatio` | "vertical", "9:16", platform list | Shorts/Reels/TikTok → `portrait` unless stated otherwise |
| `min/maxDurationSeconds` | "clips must be 15–60s" | If unstated, use 15–60 and mark **low** confidence |
| `originalAudioOnly` | "no music", "don't add audio" | |
| `captionsEnabled` | "add subtitles", "burned-in captions" | |
| `requirements.requiredCaptionLines` | "must include the exact phrase" | Copy **verbatim**, including punctuation and dates. Code checks these by exact match. |
| `requirements.requiredTags` | "tag @brand" | Include the `@` |
| `requirements.disclosureLines` | FTC section | If the brief allows one of several (`#Ad`/`#Sponsored`), put the one you'll use and note the alternatives in the reason |
| `requirements.maxAdditionalHashtags` | "no more than N hashtags" | |
| `requirements.requiredOnScreenText`, `requiredOverlayAssetIds` | watermark/logo/text-hook rules | These are checked by a person (`manual_review_required`) |
| `review.autoApprove` | — | Always `false`. Validation rejects anything else. |
| `extraction.fieldConfidence` | — | `high` only if the brief states it explicitly. Inferred or defaulted values are `low`. |
| `extraction.unresolvedFields` | — | Anything the brief doesn't cover |

Also record, in the `propose-config` reason, the rules the config can't express. The person reviewing needs them: dedicated-page requirements, audience tier, "stay live 30 days", "don't make the brand look bad", content filters like "only videos with 1win merch".

## 3. Propose it

`clipper campaign propose-config <id> --file config.json`. The campaign moves to `pending_confirmation` and the person is notified. You're done; activation happens in the web app.

If the brief is too thin to draft anything useful, `clipper campaign flag <id> --reason "..."` with the specific questions instead.
