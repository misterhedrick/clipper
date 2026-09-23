# Pre-screen candidates and draft captions

Goal: save the reviewer time. Sort candidates into recommend / hold / reject with a reason, and attach a compliant caption draft. **This is advice. A person approves in the web app.**

For each candidate in `awaiting_review` without a prescreen (`clipper candidate list --status awaiting_review`):

## 1. Judge it against the brief

You have OpusClip's title, description, hashtags, score and sub-scores, duration, and the objective check results. Also read what's actually said: `opusclip_describe_clip` returns the clip's own transcript and keywords. Judge the words, not the title. Consider:
- Do the automated checks already show a `fail`? Then `reject`, citing the check.
- Does the title or topic fit what the brief asks for ("satisfying gunplay", "standout moments")? Does it hit anything the brief forbids (making the brand look bad, off-topic, competitor mentions)?
- Is it a near-duplicate of another candidate from the same source? Recommend the stronger one and hold the other.
- Anything you **can't** judge from text is for the reviewer: on-screen text, overlay presence, visual quality, whether gameplay appears by second 4. Say so in the notes rather than implying you checked. (`opusclip_analyze_video` reports faces, screen regions and layout per keyframe. Use it only when a brief rule depends on layout, like "gameplay visible by 0:04", and say what it showed.)

`clipper candidate prescreen <id> --verdict recommend|hold|reject --notes "..."`

## 2. Draft the caption (for `recommend` and `hold`)

Build it from the campaign config:
- A short hook line relevant to the clip.
- Every `requiredCaptionLines` entry, **verbatim**.
- Every `requiredTags` entry.
- `disclosureLines` on their own line, as the brief requires.
- No more hashtags than `maxAdditionalHashtags` beyond the required ones.

`clipper candidate set-caption <id> --file caption.txt`. The CLI rejects a caption missing any requirement, with an `issues` list naming each rule it broke (`required_caption_line`, `required_tag`, `disclosure`, `hashtag_limit`). If it's rejected, fix those issues; don't work around the check. Captions can be set only while a candidate is `awaiting_review` or `needs_edit`.

## 3. Fixing clips a reviewer sent back (`needs_edit`)

Only for candidates a person marked `needs_edit`, and only the change their notes ask for. Examples: "cut the swear at 0:12" → `delete_phrase`; "caption says 'modren'" → `replace_phrase`; "trim the dead air at the start" → `trim_section` or `remove_pauses`.

1. `opusclip_edit_clip` with `dryRun: true` first, to confirm the ops do what the note asks.
2. Run it for real, then wait until `opusclip_describe_clip` shows `render_pending: false`.
3. `clipper candidate record-edit <id> --ops-file ops.json --reason "<reviewer note → what you changed>"`. The candidate returns to `awaiting_review` for the person to look again.

Don't edit clips nobody asked you to fix, and don't use edits to make a clip pass a check it failed. That's the reviewer's call.
