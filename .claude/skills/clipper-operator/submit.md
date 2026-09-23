# Submit to OpusClip

Goal: turn selected footage into OpusClip projects without spending a credit outside the protocol. The database decides whether you may spend. The connector only carries out that decision.

## 1. Check headroom
- `opusclip_get_usage`: note `monthly.remaining`. Then `clipper credits reconcile --opus-used <monthly.used> --limit <monthly.limit> --reset-at <monthly.reset_at>`.
- `clipper credits`: today's budget left, per campaign. If either is near zero, stop and report.

## 2. For each job, in priority order
Take `clipper source list --status detected`, then `--status queued`. Order by highest-paying active campaign, then by the video most likely to yield clips.

1. `clipper source validate <jobId>`. Failures move to `validation_failed` with a reason. Don't retry them; they show up in triage.
2. `clipper source reserve <jobId> --opus-remaining <monthly.remaining>`, plus:
   - `--range 0-600` for a campaign's **first** submission. Ten minutes, about 10 credits, is enough to judge output quality.
   - `--estimated-minutes <m>` if you know the length (from a title like "Full Special (58:12)" or a listing). Otherwise leave it and the default 90-minute hold applies.
   A refusal (budget, duplicate, not queued) is final for this run. Report it, don't work around it.
3. Call `opusclip_submit_project` with **exactly** the returned `submitParams`. Don't add, drop or "improve" a parameter. The guard hook compares the call to the reservation and blocks any difference.
4. Immediately record the outcome:
   - success → `clipper source record-project <jobId> --project-id <id>`
   - error → `clipper source record-failure <jobId> --error "<the connector's error text>"`

Never leave a run with a job you submitted still in `submitting`.

## 3. After a first, range-limited submission
Don't submit the rest of that campaign's footage in the same run. On a later run, once its clips are collected and pre-screened, decide whether the output fits the brief. If it does, submit full videos. If not, report why, and suggest a different footage choice, brand template or duration range before spending more.

## Never
- Resubmit a job that has an `opusclip_project_id`. If the clips are bad, that's triage.
- Resubmit a job stuck in `submitting` without the crash check in [Triage](triage.md).
- Call `opusclip_submit_project` for anything that didn't come from `reserve`, including "just a quick test".
