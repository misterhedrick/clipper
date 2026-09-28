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
4. As soon as every post is recorded: `clipper social alert`. It sends the person one Discord link that approves them all. The first slot is only 5 minutes out, so do this immediately, before anything else in the run.

## Expired approvals

An approval link stops working once its slot has passed. For each post still `requested` whose `publishAt` is in the past and that `opusclip_list_scheduled_posts` doesn't list: `clipper social cancel <postId> --reason "approval link expired"`, then plan and schedule the clip again (step 2) for fresh links. Don't do this for a post OpusClip lists as scheduled: that one was confirmed.

## 3. Hand it to the person

Under "Needs you" in the report, give **one combined link** for all the approvals (`https://clip.opus.pro/agent-approvals#<token>,<token>,...`, tokens from each `approval_url`), and list what it covers: account, platform and time. The links are web pages: on a phone they open in the browser (signed in to OpusClip), not in the OpusClip app. A post the person hasn't confirmed before its time may not go out. Say so if a slot is close.

Once links are live and sent, the person submits them on Content Rewards and taps **Mark posted** on the clip's page.
