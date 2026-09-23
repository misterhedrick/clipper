# Collect clips, then export and package

## Collect finished clips

For each job from `clipper source list --status project_created` and `--status processing`:

1. `opusclip_list_clips` with the job's project ID.
2. Save the response to a file and run `clipper candidate upsert <jobId> --file clips.json`. The CLI validates it, dedupes by clip ID, runs the objective checks, and moves new candidates to `awaiting_review`. If the response's `stage` is still in progress with no clips, the job becomes `processing`. Try again next run; an empty list mid-processing doesn't mean the project produced nothing.
3. Optionally, for a campaign's first project, call `opusclip_preview_clips` so the run report can show the top clips.

A job with no clips 6 hours after its project was recorded goes to `needs_attention` the next time you upsert it, as does a project whose stage reports a failure or that finished with no clips. Report it.

If `upsert` rejects the file as "Not an opusclip_list_clips result", don't reshape the data by hand to make it pass. Report the error and the keys the response actually had: the parser needs fixing, not the data.

After a reviewer-requested edit (see [Pre-screen](prescreen.md)), upsert the job again with a fresh `opusclip_list_clips` so the edited clip's duration is re-checked. Upsert works on `candidates_ready` jobs too, and only refreshes.

## Export and package

For each candidate a person has `approved` (`clipper candidate list --status approved`):

1. `opusclip_export_clip` (target `hd`). `rendering` means call again shortly; the call never starts a second render. `ready` means you have the URL. `unavailable` is final: report it.
2. `clipper candidate record-export <id> --url <export_url>`.
3. `clipper package <id>`. This writes the Ready-to-Post bundle to R2 and refuses anything a person didn't approve.

Export URLs expire. Record and package in the same run you exported.
