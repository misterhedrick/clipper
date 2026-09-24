# Onboard a campaign (brief → proposed config)

Goal: turn a freeform brief into a validated campaign config for a person to confirm once. Applies to campaigns in `discovered` that are classified `lf`.

## 1. Read everything the brief points to

`clipper campaign brief <id>` returns the doc text (each link shown inline as `words <url>`), every hyperlink in it, `linkedDocs` to read next, and the campaign's `referenceMaterials`. Also read:
- every entry in `linkedDocs` (sub-briefs: caption rules, content guides) with `clipper campaign brief <id> --doc <url>`;
- nothing that needs sign-in. A Notion or other page that holds the real rules but can't be read is a `campaign flag` with the link.

## 2. Draft the config

Write `config.json` matching the `CampaignConfig` schema (`docs/DATA_MODEL.md`). The CLI validates it. When the brief is silent on a field, fill it with what usually performs best for that content and platform (not a placeholder), mark it **low** confidence, and say in `unexpressedRules` what you picked and why, so the person can confirm your recommendation rather than decide from scratch. Guidance per field:

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

Put every rule the config can't express in `extraction.unexpressedRules`, one per entry. The person reviewing needs them: dedicated-page requirements, audience tier, "stay live 30 days", "don't make the brand look bad", content filters like "only videos with 1win merch".

Every field needs an entry in `extraction.fieldConfidence` or in `extraction.unresolvedFields`.

### Brand template: always set one, never leave it blank

`clipGeneration.brandTemplateId` decides what OpusClip burns into every clip (logo, watermark, caption style). If it's left out, OpusClip uses the account's default template, and on 2026-09-24 that put the **MW4 (Call of Duty) logo** in the middle of every Charlie Berens clip. Templates can't be created or edited through the API; a person makes them in OpusClip's web app.

1. `opusclip_list_brand_templates`, and match by exact name.
2. **Brief doesn't ask for a logo, watermark or overlay** (most campaigns): use the template named exactly **`Clean - No Logo`** (no logo, karaoke captions).
3. **Brief requires a logo, watermark or specific caption style:** use a template named after the campaign (e.g. `MW4`). If it doesn't exist yet, put it in "Needs you" with the exact settings: template name, which logo file from the brief, where it goes, caption style. Propose the config with the field in `unresolvedFields`, and say in `unexpressedRules` that the template must be set before confirming.
4. **Never** use another campaign's template, and never fall back to the default. If `Clean - No Logo` is missing, ask for it to be created (same as step 3) rather than leaving the field out.
5. When pre-screening a campaign's first clips, look at a thumbnail (`thumbnail_url`) for logos that don't belong to the campaign, and hold every clip that has one.

## 3. Propose it

First `clipper campaign propose-config <id> --file config.json --dry-run`. It returns every problem at once, each with its field path (`invalid_config` → `issues[]`); fix and repeat. Then run it without `--dry-run`. The campaign moves to `pending_confirmation` for a person to confirm. You're done; activation happens in the web app, and nothing you can run will activate it. The campaign must be classified `lf` first.

If the brief is too thin to draft anything useful, `clipper campaign flag <id> --reason "..."` with the specific questions instead.
