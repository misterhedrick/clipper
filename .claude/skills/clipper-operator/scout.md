# Scout campaigns

Goal: recommend campaigns worth running through this pipeline. A person decides which to join. Joining happens on Content Rewards under their account.

1. `clipper campaign scout` lists discover-page campaigns not yet tracked, with parsed metadata.
2. For each plausible one, `clipper campaign brief <contentRewardsUrl>` reads the actual brief. It works on untracked campaigns and writes nothing. Titles are unreliable.
3. Classify it. Only **LF** fits this pipeline:
   - **lf**: long-form footage exists (stream VODs, podcasts, specials, gameplay recordings, a creator's channel) and the job is cutting it into shorts.
   - **ugc**: the clipper films or records original content (persona pages, own gameplay, split-screen reactions).
   - **music**: the core requirement is a specific TikTok/IG sound over any content.
   - **slideshow**: native photo carousels.
   - **unclear**: the rules sit behind a page you can't read, or there's no brief.
4. For LF campaigns, check fit:
   - Is footage on a host OpusClip can ingest? Drive, YouTube, Dropbox, Frame.io, Loom, Vimeo, Twitch, or Content Rewards uploads. Kick, MediaSilo or a custom site means a person must source it: say so.
   - Payout per 1K views and max per clip. Budget remaining is `budgetCents` against spend where visible.
   - **Logo, watermark or overlay required → skip it.** If the brief asks for a logo, watermark, brand overlay, CTA graphic or overlay pack on the video, it's not a fit: those need an OpusClip brand template, which can only be edited on a desktop, and this pipeline is run from a phone. Don't recommend it; mention it in one line as skipped for that reason. Text the clipper writes (a hook, a caption) is fine.
   - Requirements this setup can't meet: dedicated page, audience tier, a new account, an application.
   - Rules that would cause most OpusClip output to be rejected, e.g. "gameplay must appear in the first 4 seconds" or heavy editing requirements.
5. Recommend at most five, ranked, one line each: *why it fits, what it needs from a person (join / apply / dedicated page), the expected footage host*. Include the Content Rewards URL.
6. Don't `campaign add` anything during scouting unless the person asked you to. Adding is their call.

When a person says "add these", run `clipper campaign add <url>` for each, then `clipper campaign classify <id> --type ... --reason ...`.
