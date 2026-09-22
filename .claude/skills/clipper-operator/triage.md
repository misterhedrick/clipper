# Triage Needs Attention

Goal: every `needs_attention`, `validation_failed` and `submit_failed` item ends the run either resolved, or turned into a clear question for a person. None sits there silently.

`clipper attention list` gives each item with its reason and error details. Common cases:

| Reason | What to do |
|---|---|
| `guideline_doc_not_public`, folder asks for sign-in | Nothing you can fix. Report it: "Brief for <campaign> isn't public. Ask the campaign owner in their Discord, or skip the campaign." |
| Unsupported footage host (Kick, MediaSilo, portal) | Report the link. The fix is a person downloading and re-sharing, or skipping. |
| `unsupported_extension`, file too large/long | Confirm the file really isn't usable. `footage skip` it with the reason so it isn't re-selected. |
| Drive quota / "too many users" / timeout | Transient. The job retries automatically on the next `sync` up to its retry limit. Only report it if the retry count is exhausted. |
| OpusClip rejected the URL | Check the URL form matches the kind table in `docs/ARCHITECTURE.md`. If it's a code bug, say so and include the error. Don't resubmit by hand. |
| Insufficient credits | Report it. Don't retry. |
| Campaign ended or paused on Content Rewards | Report it and suggest pausing the campaign here. |

If the same reason appears on many items, report it once as a pattern with the count, not one line per item.
