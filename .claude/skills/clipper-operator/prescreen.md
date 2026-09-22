# Pre-screen candidates and draft captions

Goal: save the reviewer time. Sort candidates into recommend / hold / reject with a reason, and attach a compliant caption draft. **This is advice. A person approves in the web app.**

For each candidate in `awaiting_review` without a prescreen (`clipper candidate list --status awaiting_review`):

## 1. Judge it against the brief

You have OpusClip's title, description, hashtags, score, duration, and the objective check results. Consider:
- Do the automated checks already show a `fail`? Then `reject`, citing the check.
- Does the title or topic fit what the brief asks for ("satisfying gunplay", "standout moments")? Does it hit anything the brief forbids (making the brand look bad, off-topic, competitor mentions)?
- Is it a near-duplicate of another candidate from the same source? Recommend the stronger one and hold the other.
- Anything you **can't** judge from text is for the reviewer: on-screen text, overlay presence, visual quality, whether gameplay appears by second 4. Say so in the notes rather than implying you checked.

`clipper candidate prescreen <id> --verdict recommend|hold|reject --notes "..."`

## 2. Draft the caption (for `recommend` and `hold`)

Build it from the campaign config:
- A short hook line relevant to the clip.
- Every `requiredCaptionLines` entry, **verbatim**.
- Every `requiredTags` entry.
- `disclosureLines` on their own line, as the brief requires.
- No more hashtags than `maxAdditionalHashtags` beyond the required ones.

`clipper candidate set-caption <id> --file caption.txt`. The CLI rejects a caption missing any requirement. If it's rejected, fix it; don't work around the check.
