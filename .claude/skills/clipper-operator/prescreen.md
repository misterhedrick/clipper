# Pre-screen candidates and draft captions

Goal: save the reviewer time. Sort candidates into recommend / hold / reject with a reason, and attach a compliant caption draft. **This is advice. A person approves in the web app.**

For each candidate in `awaiting_review` without a prescreen (`clipper candidate list --status awaiting_review`), in this order. Skip straight to a `reject` verdict only when a code check already failed (e.g. `duration`, or `english_language`: OpusClip wrote the clip's title and description in another language); everything else gets looked at.

## 1. Look at the clip (required)

A recommend or hold vouches for what's on screen, so the CLI refuses those verdicts until the clip's current render has a visual review. The review settles every check the clip data can't: the campaign's `review.requiredChecks`, `required_on_screen_text`, `required_overlay`, `aspect_ratio`, and `english_language` (the speech and burned-in captions are English; every clip, every campaign). Duration and the caption stay code's.

1. `clipper candidate frames <id>`: downloads the preview and writes frames to a local folder (`outDir`). It returns `visualChecks`, the exact checks to judge, and contact `sheets` whose `times` list each frame's second, left to right then top to bottom. The opening is sampled densely because briefs judge the first 2 seconds.
2. Read the campaign's rules: `clipper campaign show <campaignId>` (`requirements`, `review.requiredChecks`, `extraction.unexpressedRules`).
3. Look at every sheet (Read the image files). Read the transcript too (`opusclip_describe_clip`) and find where the brand or any rule-bound word is spoken; get full-size stills there with `--at <sec,sec>` to read the burned-in caption word exactly. For each visual check, decide:
   - `pass`: you saw it satisfied. Say where ("BOXABL sign 0:21", "captions read 'BOXABL' at 0:02").
   - `fail`: you saw it broken. Say exactly what and when ("captions read 'BOXABLE' at 0:13").
   - `manual_review_required`: frames can't settle it (motion, audio, pacing, a rule about the whole cut). Say why.
   Also note anything off-brief you spot, even with no check for it (another brand's watermark, a clip that ends mid-sentence, a talking head where the brief wants the product).
4. Record it: `clipper candidate visual-review <id> --file review.json` with
   ```json
   {"framesChecked": 18, "summary": "one or two sentences a reviewer can trust",
    "checks": {"<each visualChecks name>": {"result": "pass|fail|manual_review_required", "evidence": "what you saw, with times"}}}
   ```
   It must cover exactly `visualChecks`. The results replace the `manual_review_required` placeholders in the clip's checks, and a `fail` means approving needs the reviewer's explicit override. This is the review data the reviewer sees under each check; don't also paste it into the pre-screen notes.

Frames are only as good as the preview: if `frames` says the link expired, upsert the job again with a fresh `opusclip_list_clips` first.

## 1b. Fix what an edit can fix (automatic)

If the visual review recorded a `fail` that an OpusClip edit can genuinely fix, fix it yourself, without waiting for a person. Fixable examples:
- a misheard brand or word in the captions ("BOXABLE" → "BOXABL"): `replace_phrase` (same number of words; `occurrence: "all"` when it repeats);
- a forbidden word or phrase spoken in the clip: `delete_phrase`;
- a bad opening, dead air or a section that breaks a rule: `trim_section`, `drop_section`, `remove_pauses`;
- a clip over the length limit: `trim_section`;
- **double captions** (`no_double_captions` failed: the source video's own burned-in captions show under OpusClip's): `set_captions` with `enabled: false`, keeping the creator's captions (the person's rule, 2026-09-30). This is the only case where captions may be turned off. Also run `clipper source mark-captions <jobId> --reason "..."` so any later submission of that video goes in without OpusClip's captions.

Not fixable by editing, so leave it failed: no home shown, the wrong subject, too short, no BOXABL on screen. Never add a text overlay, or turn captions off for anything but double captions, to make a check pass; the edit guard refuses those.

Every clip's visual review has a `no_double_captions` check: `fail` when a second caption layer from the source video is visible anywhere (say where), `pass` when only one layer shows. When captions were switched off because of it, a spelling check on OpusClip's captions no longer applies: judge the creator's captions instead.

1. `opusclip_edit_clip` with `dryRun: true`, and confirm the ops do exactly the fix.
2. Run it for real, then poll `opusclip_describe_clip` until `render_pending: false`.
3. `clipper candidate record-edit <id> --ops-file ops.json --reason "<what failed, with the evidence> → <what you changed>" --fixes <failed check names>`. The clip stays in `awaiting_review`; its visual review and pre-screen are cleared because they described the old render.
4. Upsert the job again with a fresh `opusclip_list_clips` (new duration and preview), then go back to step 1: frames, visual review, then judge.

A hook (`clipper guard edit`) blocks any real edit that isn't a reviewer's `needs_edit` or a fix of a clip with a failed check, using fixing ops only, at most 2 automatic fixes per clip. If a second fix still fails the check, stop: the verdict is `reject` (and `reject-failed` removes it) or a `hold` with notes for the reviewer.

## 2. Judge it against the brief

With the checks settled, decide the verdict. Use OpusClip's title, description, hashtags, score and sub-scores, and the transcript: judge the words, not the title. Consider:
- Did any check `fail` (code's or yours)? Then `reject`, or `hold` if one reviewer-requested edit would fix it (e.g. a misspelled caption word: say which edit in the notes).
- Does the topic fit what the brief asks for? Does it hit anything the brief forbids (making the brand look bad, off-topic, competitor mentions)?
- Is it a near-duplicate of another candidate from the same source? Recommend the stronger one and hold the other.

`clipper candidate prescreen <id> --verdict recommend|hold|reject --notes "..."`

When every candidate is pre-screened, run `clipper candidate reject-failed`. It rejects, for good, each clip that has a failed check (code's, or yours with evidence) **and** your `reject` verdict, with the failed checks and evidence as the reason. It leaves alone a held clip with a failed check (waiting on a fix) and a `reject` with no failed check (a taste call); those stay for a person. So record `fail` only for what you actually saw, and to reject a clip whose checks all passed, say why in the verdict and leave it to the reviewer. Report the count, and list `keptWithFailures` only if a held clip's fix is waiting on the reviewer.

## 3. Draft the caption (for `recommend` and `hold`)

Build it from the campaign config:
- A short hook line relevant to the clip.
- Every `requiredCaptionLines` entry, **verbatim**.
- Every `requiredTags` entry.
- `disclosureLines` on their own line, as the brief requires.
- No more hashtags than `maxAdditionalHashtags` beyond the required ones.

`clipper candidate set-caption <id> --file caption.txt`. The CLI rejects a caption missing any requirement, with an `issues` list naming each rule it broke (`required_caption_line`, `required_tag`, `disclosure`, `hashtag_limit`). If it's rejected, fix those issues; don't work around the check. Captions can be set only while a candidate is `awaiting_review` or `needs_edit`.

## 4. Fixing clips a reviewer sent back (`needs_edit`)

Only for candidates a person marked `needs_edit`, and only the change their notes ask for. Examples: "cut the swear at 0:12" → `delete_phrase`; "caption says 'modren'" → `replace_phrase`; "trim the dead air at the start" → `trim_section` or `remove_pauses`.

1. `opusclip_edit_clip` with `dryRun: true` first, to confirm the ops do what the note asks.
2. Run it for real, then wait until `opusclip_describe_clip` shows `render_pending: false`.
3. `clipper candidate record-edit <id> --ops-file ops.json --reason "<reviewer note → what you changed>"`. The candidate returns to `awaiting_review` for the person to look again.
4. The edit made the old visual review stale (its checks went back to `manual_review_required`), so do step 1 again on the new render before you pre-screen it.

Outside step 1b, don't edit clips nobody asked you to fix.
