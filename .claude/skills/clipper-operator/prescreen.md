# Pre-screen candidates and draft captions

Goal: save the reviewer time. Sort candidates into recommend / hold / reject with a reason, and attach a compliant caption draft. **This is advice. A person approves in the web app.**

For each candidate in `awaiting_review` without a prescreen (`clipper candidate list --status awaiting_review`), in this order. Skip straight to a `reject` verdict only when a code check already failed (e.g. `duration`); everything else gets looked at.

## 1. Look at the clip (required)

A recommend or hold vouches for what's on screen, so the CLI refuses those verdicts until the clip's current render has a visual review. The review settles every check the clip data can't: the campaign's `review.requiredChecks`, `required_on_screen_text`, `required_overlay` and `aspect_ratio`. Duration and the caption stay code's.

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

## 2. Judge it against the brief

With the checks settled, decide the verdict. Use OpusClip's title, description, hashtags, score and sub-scores, and the transcript: judge the words, not the title. Consider:
- Did any check `fail` (code's or yours)? Then `reject`, or `hold` if one reviewer-requested edit would fix it (e.g. a misspelled caption word: say which edit in the notes).
- Does the topic fit what the brief asks for? Does it hit anything the brief forbids (making the brand look bad, off-topic, competitor mentions)?
- Is it a near-duplicate of another candidate from the same source? Recommend the stronger one and hold the other.

`clipper candidate prescreen <id> --verdict recommend|hold|reject --notes "..."`

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

Don't edit clips nobody asked you to fix, and don't use edits to make a clip pass a check it failed. That's the reviewer's call.
