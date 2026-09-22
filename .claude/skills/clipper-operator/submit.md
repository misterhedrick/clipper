# Submit to OpusClip

Goal: turn `detected` source jobs into OpusClip projects without wasting credits.

1. `clipper credits`: see what's left today and per campaign. If near the limit, stop and report.
2. `clipper source list --status detected`.
3. For each job, in the order most likely to pay off (highest-paying active campaign, longest video):
   - `clipper source validate <id>`. On failure the job moves to `validation_failed` with a reason. Don't retry it. It appears in triage.
   - `clipper source submit <id>`. Safe to re-run: the CLI won't create a second project for the same job.
4. For a campaign's **first** submission, submit one video only. Wait for its candidates on a later run and pre-screen them. Submit the rest only if the output looks usable for this campaign's rules. Note this in the report.

Never re-submit a job that already has an `opusclip_project_id` to "try again". If OpusClip output is bad, that's triage, not a resubmit.
