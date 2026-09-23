# Source footage

Goal: for each `active` campaign, register where its footage lives and choose which videos to process. This is where most of your judgment goes.

## 1. Find candidate links

From `clipper campaign brief <id>`: `referenceMaterials` URLs plus doc hyperlinks. Use the words each link sits on: in the text, links appear as `words <url>`, and labels like `VIDEO OVERLAY`, `Clip Examples Folder` or `Raw footage` usually say what's behind them. Classify each link:
- **Footage**: Drive folders/files, YouTube channels/videos, Dropbox, Frame.io, Loom, Vimeo, Twitch, Content Rewards `type: video` uploads.
- **Not footage**: logos, fonts, overlay packs, example clips ("here's what good looks like"), social profiles to tag, Discord/WhatsApp/Whop links, forms.
- **Footage on an unsupported host** (Kick, MediaSilo, custom portals): `clipper campaign flag` with the link. A person has to get the video somewhere OpusClip can read.

Register each footage link: `clipper footage add <campaignId> --url <url> --label "<what it is>" --reason "<where in the brief, why it's footage>"`.

## 2. Look inside

`clipper footage list-url <url>` expands folders recursively and channels to recent videos. Real examples of what you'll see:

| Folder contents | Choose | Why |
|---|---|---|
| `Raw to edit/`, `B-rolls for clippers/`, `Podcast RZ Experience/` | `Raw to edit` and `Podcast…` | B-roll is cutaway material, not a clip source |
| `Un-Edited Clips/`, `Hype Reel / Well Edited/`, `Memes Only/`, `Nilo Logos = UI Elements/`, `Static Assets / Still Image/` | `Un-Edited Clips` | The rest are finished edits, assets or stills |
| `Charlie Berens Midwest Goodbye (Full Special).mp4`, `…Neighborly (FULL SPECIAL 2025).mp4` | both | Full-length specials are ideal OpusClip input |
| `RL-Security.mp4`, `ROLL_DADDY_MEDIA_TV30_…_BROADCAST.mp4` (30s spots) | usually skip | Too short to clip; likely finished promos. Check length first |

For YouTube channels, apply the brief's content filter. If it says "videos with 1win merch", select only videos whose title or description suggests it, and say how you judged. If the filter can't be checked from title and description, flag it rather than guessing. Prefer recent, long, talk-heavy uploads, and skip Shorts.

## 3. Select or skip, explicitly

For each video: `clipper footage select … --reason` or `clipper footage skip … --reason`. Recording skips matters: it stops the next run from re-evaluating the same file. On later runs, `list-url` shows new files. Only decide on those.

Things to skip:
- Files under ~2 minutes, which are probably finished clips or promos.
- Images, audio-only files, project files (`.prproj`), zips.
- Duplicates of the same video under another name or in another folder.
