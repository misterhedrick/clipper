# Post

Every packaged clip goes to each account in `docs/SOCIAL_ACCOUNTS.md` through OpusClip. You schedule; **the person confirms each post in the OpusClip app**, and OpusClip posts nothing until they do. You never post, and you never mark a clip posted: the person does that on the review page.

## 1. Sync what's already out

If any posts are waiting (`clipper social list`), read their status first:

1. `opusclip_list_scheduled_posts` with `startAt` = 7 days ago and `endAt` = 30 days ahead (ISO 8601 UTC).
2. `clipper social sync --file -` with that result on stdin. Confirmed posts become `scheduled`, live ones `posted` with their link, failed ones `failed` (with OpusClip's reason). New live links go to the person on Discord, with each campaign's Content Rewards page, once each.

A post that is `posted` without a link is TikTok Business lagging: sync again next run. For a `failed` post, report the reason. Running `social plan` again gives that account a fresh slot, but do that only when the reason is fixable (e.g. an account reconnected), not in a loop.

## 2. Schedule new clips

For each `ready_to_post` clip (`clipper candidate list --status ready_to_post`):

1. `clipper social plan <candidateId>`. It returns one post per account, each with its slot (at least 3 hours after that account's last post, at most 4 a day) and the exact `params`. Running it again returns the same posts.
2. For each post still `planned`: call `opusclip_schedule_publish` with exactly its `params`. A hook (`clipper guard post`) blocks anything else, including `opusclip_create_post_task`: every post takes a slot.
3. Record the answer: `clipper social requested <postId> --approval-url <approval_url>`, or `--error "<message>"` when the call failed (that frees the slot).

## 3. Hand it to the person

Under "Needs you" in the report, list each approval link with its account and time: "Confirm in OpusClip: TikTok @hedrick.clips, goes out 14:15 UTC: <approval_url>". A post the person hasn't confirmed before its time may not go out. Say so if a slot is close.

Once links are live and sent, the person submits them on Content Rewards and taps **Mark posted** on the clip's page.
