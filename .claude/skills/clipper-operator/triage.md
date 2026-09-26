# Triage Needs Attention

Goal: every `needs_attention`, `validation_failed` and `submit_failed` item ends the run either resolved, or turned into a clear question for a person. None sits there silently.

`clipper attention list` gives each item with its reason and error details. Common cases:

| Reason | What to do |
|---|---|
| `guideline_doc_not_public`, folder asks for sign-in | Nothing you can fix. Report it: "Brief for <campaign> isn't public. Ask the campaign owner in their Discord, or skip the campaign." |
| Unsupported footage host (Kick, MediaSilo, portal) | Report the link. The fix is a person downloading and re-sharing, or skipping. |
| `unsupported_extension`, file too large/long | Confirm the file really isn't usable. `footage skip` it with the reason so it isn't re-selected. |
| Drive quota / "too many users" / timeout | Transient. `record-failure` already put the job back in `queued`; it gets reserved again on a later run, up to 3 tries, then lands here. Only report it once retries are exhausted. |
| OpusClip "having trouble processing your video at the moment … credits have been returned" | OpusClip's own hiccup: no project is made and nothing is charged. `record-failure` re-queues it as transient and **keeps the upload**, so the retry doesn't re-copy the file. Reserve and submit it once more at the end of the same run; if it fails again, leave it for a later run (3 tries, then it lands here). Only report it once retries are exhausted. |
| OpusClip rejected the URL | Check the URL form matches the kind table in `docs/ARCHITECTURE.md`. If it's a code bug, say so and include the error. Don't resubmit by hand. Once the cause is fixed (e.g. a Drive job submitted as a link before uploads existed), `clipper source validate <jobId>` re-queues it and drops any old upload; then go through [Submit](submit.md) as normal. |
| Insufficient credits, or `reserve` refused for budget | Report it with the `clipper credits` numbers. Don't retry. |
| Hook blocked a submit | Something differed from the reservation. Report exactly what, and don't retry with edited parameters. |
| Campaign ended or paused on Content Rewards | Report it and suggest pausing the campaign here. |

**Jobs stuck in `submitting`** (a run ended between reserve and record). For each: `opusclip_list_projects` and look for the title `clipper:<jobId>`.
- Found → `clipper source record-project <jobId> --project-id <id>`. The submission happened; this just records it.
- Not found → `clipper source record-failure <jobId> --error "no project found after interrupted submit"`. The reservation is released and the job can be reserved again.

Do this before any submitting in the run.

If the same reason appears on many items, report it once as a pattern with the count, not one line per item.
