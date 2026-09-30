# Onboard a campaign (brief → verified config → active)

Goal: turn a freeform brief into a campaign config, check it against the campaign page and brief until it's right, and activate the campaign yourself (standing rule, 2026-09-27). A person is only pulled in when something can't be settled. Applies to campaigns in `discovered` that are classified `lf`.

## 1. Read everything the brief points to

`clipper campaign brief <id>` returns the doc text (each link shown inline as `words <url>`), every hyperlink in it, `linkedDocs` to read next, and the campaign's `referenceMaterials`. Also read:
- every entry in `linkedDocs` (sub-briefs: caption rules, content guides) with `clipper campaign brief <id> --doc <url>`;
- public Notion pages too: when a campaign has no Google Doc, `campaign brief` reads a Notion rules page from its reference materials, and `--doc` takes Notion links. Text in link previews and databases isn't included (the output says so): if the rules seem to continue there, flag it.
- nothing that needs sign-in. A page that holds the real rules but can't be read (`not_public`, or a host other than Google Docs and Notion) is a `campaign flag` with the link.

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
| `requirements.requiredOnScreenText` | text-hook rules ("add a hook in the first 2 seconds") | Checked by a person (`manual_review_required`) |
| — | "no AI edits", "no Opus Clips or any auto-clipping tool" | **Not taken on.** Every clip here is cut by OpusClip. `clipper campaign flag <id> --reason "bans auto-clipping tools (OpusClip): not taken on"`, quoting the rule. |
| `requirements.requiredOverlayAssetIds` | logo / watermark / overlay rules | **Always empty.** A brief that requires a logo, watermark or overlay isn't taken on: `clipper campaign flag <id> --reason "requires <what> overlay: not taken on (logo campaigns need a desktop-only OpusClip template)"` instead of proposing a config. The CLI rejects a config with overlays anyway. |
| `review.autoApprove` | — | Always `false`. Validation rejects anything else. |
| `extraction.fieldConfidence` | — | `high` only if the brief states it explicitly. Inferred or defaulted values are `low`. |
| `extraction.unresolvedFields` | — | Anything the brief doesn't cover |

Put every rule the config can't express in `extraction.unexpressedRules`, one per entry. The person reviewing needs them: dedicated-page requirements, audience tier, "stay live 30 days", "don't make the brand look bad", content filters like "only videos with 1win merch".

Every field needs an entry in `extraction.fieldConfidence` or in `extraction.unresolvedFields`.

### Brand template: always set one, never leave it blank

`clipGeneration.brandTemplateId` decides what OpusClip burns into every clip (logo, watermark, caption style). If it's left out, OpusClip uses the account's default template, and on 2026-09-24 that put the **MW4 (Call of Duty) logo** in the middle of every Charlie Berens clip. Templates can't be created or edited through the API; a person makes them in OpusClip's web app.

**The account's default template is kept clean: no logo, no overlay, karaoke captions** (cleared 2026-09-24; since 2026-09-26 it is `Default-Template`, the only template on the account). Every campaign uses it, since campaigns that require a logo aren't taken on. Never ask for a logo to be added to the default.

1. `opusclip_list_brand_templates`.
2. **Brief doesn't ask for a logo, watermark or overlay** (most campaigns): use the template with `is_default: true` (`Default-Template`, ID `cmu2pvwct0456z090u3hcdq02`; always go by `is_default`, not the name or a remembered ID). Put its ID in `brandTemplateId` so the choice is visible in the config.
3. **Brief requires a logo, watermark or overlay:** don't onboard it; flag it (see `requiredOverlayAssetIds` above). A brief that only asks for a caption style can use the default; note the style in `unexpressedRules` for the reviewer.
4. **Never** use another campaign's template (the old `MW4` one is deleted; if a campaign-specific template ever reappears, don't use it for other campaigns).
5. When pre-screening a campaign's first clips, look at a thumbnail (`thumbnail_url`) for logos that don't belong to the campaign, and hold every clip that has one. A stray logo on a default-template clip means someone changed the default: report it.

## 3. Propose it

First `clipper campaign propose-config <id> --file config.json --dry-run`. It returns every problem at once, each with its field path (`invalid_config` → `issues[]`); fix and repeat. Then run it without `--dry-run`. The campaign moves to `pending_confirmation`. The campaign must be classified `lf` first.

If the brief is too thin to draft anything useful, `clipper campaign flag <id> --reason "..."` with the specific questions instead.

## 4. Verify it against the source, then activate

Check your own draft as if someone else wrote it. Re-read the sources fresh (`clipper campaign show <id>` for the campaign page and its reference materials, `clipper campaign brief <id>` plus every linked sub-doc), not your memory of them, and compare field by field:

- **match**: the config says what the page or brief says, or, where they're silent, holds a sensible recommended value you can justify (quote the justification). Evidence quotes the source: `"Brief: 'clips 15–60 seconds'"`, or `"Brief silent on length; 15–60s fits TikTok/Reels/Shorts and leaves time to show the home"`.
- **mismatch**: the config contradicts the source, or misses part of it. Say what the source says.
- **unsettled**: you can't tell what's right, even with a recommendation: the brief is ambiguous or contradicts itself, or a value only the campaign owner knows (a tracking link, an account to tag that isn't named).

Also list every rule on the page or in the brief that the config doesn't capture anywhere (not in a field, `review.requiredChecks` or `extraction.unexpressedRules`) as a `missedRules` entry.

`clipper campaign verify-config <id> --file verification.json` with
```json
{"sources": ["<campaign page URL>", "<brief doc URL>", "..."],
 "summary": "what you compared and what you found",
 "fields": {"<every config field>": {"result": "match|mismatch|unsettled", "evidence": "..."}},
 "missedRules": []}
```
It must cover every config field (`clipGeneration.*` and `requirements.*`). The outcome decides the next step:
- `verified` → `clipper campaign activate <id>`. The campaign goes live and footage sourcing and submitting start in this same run. The attention digest tells the person to join it on Content Rewards; there's nothing else to ask them.
- `needs_changes` → fix exactly what the round found, `propose-config` again, and verify again (a new round, with the sources re-read). You get 3 rounds; a third round that still doesn't match flags the campaign for a person automatically.
- `unsettled` → the campaign is flagged for a person automatically, with your evidence as the reason.

`activate` refuses a config with unresolved fields, one that changed after it was verified, or one whose last round didn't verify. Don't mark a field `match` you didn't actually check: the evidence is what the person reads if something goes wrong.

A brief that needs sign-in, or a campaign that requires a logo or overlay, is flagged as before, never activated.
