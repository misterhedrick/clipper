# Collect clips, then export and package

## Collect finished clips

For each job from `clipper source list --status project_created` and `--status processing`:

1. `opusclip_list_clips` with the job's project ID.
2. Save the response to a file and run `clipper candidate upsert <jobId> --file clips.json`. The CLI validates it, dedupes by clip ID, runs the objective checks, and moves new candidates to `awaiting_review`. If the response's `stage` is still in progress with no clips, the job becomes `processing`. Try again next run; an empty list mid-processing doesn't mean the project produced nothing.
3. Optionally, for a campaign's first project, call `opusclip_preview_clips` so the run report can show the top clips.

A job stuck in `processing` for over 6 hours goes to `needs_attention` by itself. Report it.

## Export and package

For each candidate a person has `approved` (`clipper candidate list --status approved`):

1. `opusclip_export_clip` (target `hd`). `rendering` means call again shortly; the call never starts a second render. `ready` means you have the URL. `unavailable` is final: report it.
2. `clipper candidate record-export <id> --url <export_url>`.
3. `clipper package <id>`. This writes the Ready-to-Post bundle to R2 and refuses anything a person didn't approve.

Export URLs expire. Record and package in the same run you exported.
