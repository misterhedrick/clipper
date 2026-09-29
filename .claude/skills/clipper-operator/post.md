# Post

**Nothing is scheduled ahead (decided 2026-09-29).** Approved clips wait in a queue (`clipper social queue`, oldest approval first) until the person says **"post next"** (or "post the next N"). Only then do you schedule, and only the clip(s) at the front of the queue: the person has to be there to confirm in OpusClip and submit on Whop within 30 minutes, so posting is on their word, never on a run's own. A normal operator run only does step 1 (sync) and keeps queued clips exported and packaged (see [Export and package](collect.md#export-and-package)).

Every clip goes to each account in `docs/SOCIAL_ACCOUNTS.md` through OpusClip. You schedule; **the person confirms each post in the OpusClip app**, and OpusClip posts nothing until they do. You never post, and you never mark a clip posted: the person does that on the review page.

## 1. Sync what's already out

If any posts are waiting (`clipper social list`), read their status first:

1. `opusclip_list_scheduled_posts` with `startAt` = 7 days ago and `endAt` = 30 days ahead (ISO 8601 UTC).
2. `clipper social sync --file -` with that result on stdin. Confirmed posts become `scheduled`, live ones `posted` with their link, failed ones `failed` (with OpusClip's reason). New live links go to the person on Discord once each, with where to submit (Whop → profile → Joined) and the 30-minute deadline. OpusClip lists posts by platform, not account.

A post that is `posted` without a link is TikTok Business lagging: sync again next run. For a `failed` post, report the reason. Running `social plan` again gives that account a fresh slot, but do that only when the reason is fixable (e.g. an account reconnected), not in a loop.

## 2. "Post next": schedule the front of the queue

Only when the person says "post next". Take the first entry of `clipper social queue` (or the first N for "post the next N"):

0. If it isn't packaged yet (`packaged: false`): export and package it first (`opusclip_export_clip`, `candidate record-export`, `clipper package`).
1. `clipper social plan <candidateId>`. It returns one post per account, 15 minutes out, with the exact `params`, plus `spacingWarnings` when an account posted within 3 hours or would pass 4 in a day. Those are advice: mention them in one line, don't hold the post. Running it again returns the same posts.
2. For each post still `planned`: call `opusclip_schedule_publish` with exactly its `params`. A hook (`clipper guard post`) blocks anything else, including `opusclip_create_post_task`: every post takes a slot.
3. Record the answer: `clipper social requested <postId> --approval-url <approval_url>`, or `--error "<message>"` when the call failed (that frees the slot).
4. As soon as every post is recorded: `clipper social alert`. It sends the person one Discord link that approves them all. The first slot is only 15 minutes out, so run `social plan` only once the clip is exported and packaged, send all the schedule requests straight after it, and alert immediately, before anything else in the run. If a slot passes before the requests are all out, `social cancel` them and plan again.
5. **Stay and watch until they're live.** A link must be submitted on Whop within 30 minutes of the post going live (Boxabl, seen 2026-09-28: three posts missed it because the links came hours later). So don't end the run: carry on with the other steps, and about once a minute after the first slot, call `opusclip_list_scheduled_posts` for the clip's project and pipe it to `clipper social sync --file -`. Each live link goes to Discord the moment it appears, with its deadline. Stop when `stillWaiting` is 0, or after 30 minutes past the last slot. Report any post still not live (TikTok links can lag; Instagram took over an hour once).

## Expired approvals

An approval link stops working once its slot has passed. For each post still `requested` whose `publishAt` is in the past and that `opusclip_list_scheduled_posts` doesn't list: `clipper social cancel <postId> --reason "approval link expired"`, then plan and schedule the clip again (step 2) for fresh links. Don't do this for a post OpusClip lists as scheduled: that one was confirmed.

## 3. Hand it to the person

Give the person every posting time in US Eastern (e.g. "12:32 PM ET"), never UTC; the CLI's Discord messages already do. OpusClip's tools still take and return UTC.


Under "Needs you" in the report, give **one combined link** for all the approvals (`https://clip.opus.pro/agent-approvals#<token>,<token>,...`, tokens from each `approval_url`), and list what it covers: account, platform and time. The links are web pages: on a phone they open in the browser (signed in to OpusClip), not in the OpusClip app. A post the person hasn't confirmed before its time may not go out. Say so if a slot is close.

Once links are live and sent, the person submits them on **Whop** (their profile → **Joined** tab → the campaign) within 30 minutes of posting, and taps **Mark posted** on the clip's page.
