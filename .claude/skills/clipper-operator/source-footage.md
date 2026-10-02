# Source footage

Goal: for each `active` campaign, register where its footage lives and choose which videos to process. This is where most of your judgment goes.

## 1. Find candidate links

From `clipper campaign brief <id>`: `referenceMaterials` URLs plus doc hyperlinks. Use the words each link sits on: in the text, links appear as `words <url>`, and labels like `VIDEO OVERLAY`, `Clip Examples Folder` or `Raw footage` usually say what's behind them. Classify each link:
- **Footage**: Drive folders/files, YouTube channels/videos, Dropbox, Frame.io, Loom, Vimeo, Twitch, Content Rewards `type: video` uploads.
- **Not footage**: logos, fonts, overlay packs, example clips ("here's what good looks like"), social profiles to tag, Discord/WhatsApp/Whop links, forms.
- **Footage on an unsupported host** (Kick, MediaSilo, custom portals): `clipper campaign flag` with the link. A person has to get the video somewhere OpusClip can read.

Register each footage link: `clipper footage add <campaignId> --url <url> --label "<what it is>" --reason "<where in the brief, why it's footage>"`. `unsupported_host` in reply means OpusClip can't ingest it (Kick, MediaSilo, Notion, a private Dropbox path): flag the campaign with the link.

## 2. Look inside

`clipper footage list-url <url> --campaign <campaignId>` expands folders recursively (each entry has its folder `path`) and channels to their 15 most recent uploads. Each entry says `isVideo` (from Drive's file type or the extension), and YouTube entries say `isShort`. With `--campaign`, entries you've already decided carry `decision`, and `undecidedVideos` counts the new ones. On later runs, only decide those. A Dropbox folder comes back `listable: false`: flag it so a person can paste direct file links. Real examples of what you'll see:

| Folder contents | Choose | Why |
|---|---|---|
| `Raw to edit/`, `B-rolls for clippers/`, `Podcast RZ Experience/` | `Raw to edit` and `Podcast…` | B-roll is cutaway material, not a clip source |
| `Un-Edited Clips/`, `Hype Reel / Well Edited/`, `Memes Only/`, `Nilo Logos = UI Elements/`, `Static Assets / Still Image/` | `Un-Edited Clips` | The rest are finished edits, assets or stills |
| `Charlie Berens Midwest Goodbye (Full Special).mp4`, `…Neighborly (FULL SPECIAL 2025).mp4` | both | Full-length specials are ideal OpusClip input |
| `RL-Security.mp4`, `ROLL_DADDY_MEDIA_TV30_…_BROADCAST.mp4` (30s spots) | usually skip | Too short to clip; likely finished promos. Check length first |

For YouTube channels, apply the brief's content filter. If it says "videos with 1win merch", select only videos whose title or description suggests it, and say how you judged. If the filter can't be checked from title and description, flag it rather than guessing. Prefer recent, long, talk-heavy uploads, and skip Shorts.

## 3. Select or skip, explicitly

For each video: `clipper footage select <campaignId> --url <entry.url> --name "<entry.name>" --path "<entry.path>" --from <registered source url> --reason "..."`, or the same with `footage skip`. Recording skips matters: it stops the next run from re-evaluating the same file. Decisions are final: a different decision on the same video returns `already_decided`, and only a person can change it.

**Videos that already have captions.** Many creators burn their own subtitles into their videos (big YouTubers especially: FaZe Rug's Boxabl video does). OpusClip's captions then land on top of theirs. When you can tell a video has them (from the creator's other clips, a thumbnail, or an earlier project from the same channel), select it with `--source-captions`: it goes to OpusClip with captions off. If you only find out from its clips, the pre-screen turns captions off on those clips and marks the video (`source mark-captions`).

Things to skip:
- **Anything not in English.** Every account posts in English (2026-09-28). Before selecting, confirm the video's language from its title, description and channel, not from the creator's view count or a brand's approved list: a Turkish creator's tour cost 30 credits for 31 unusable clips. A non-English or unclear video is skipped with the language as the reason ("Turkish-language tour; accounts are English").
- **Wide footage that won't survive a vertical crop** (the person's rule, 2026-10-02). OpusClip crops wide video to 9:16 and there's no letterbox/"fit" option we use: fit leaves a small picture with big bars, which performs worse and reads as a repost. So skip videos built on wide, busy shots: run-and-gun vlogs with several people across the frame, stunts, crowds, wide factory or room tours, and creators whose own burned-in captions span the full width (they get cut off at both edges). FaZe Rug's Boxabl video is the example: its clips came out "way too far zoomed in" with captions cut to "are about to t…" and were all rejected. Prefer one person talking to camera, interviews and podcasts, walk-and-talk tours that keep the subject centred, and anything already vertical. Judge from the thumbnail and title, and from earlier projects of the same channel; when unsure, start with a short `--range` and look at the first clips before spending more.
- Files under ~2 minutes, which are probably finished clips or promos.
- Images, audio-only files, project files (`.prproj`), zips.
- Duplicates of the same video under another name or in another folder.
