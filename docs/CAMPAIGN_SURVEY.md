# Campaign Survey (2026-09-22)

A scan of every campaign listed on `contentrewards.com/discover` (50 campaigns, all `active`, all CPM) plus the MW4 reference campaign, run through `campaign-connector`. Each campaign's guideline doc was fetched as HTML to capture hyperlinks. Plain-text export drops links, so link counts from `export?format=txt` undercount. This survey is the evidence behind the design in `ARCHITECTURE.md`.

## Headline findings

1. **Only about 60% of campaigns are "clip this footage" work.** The rest ask for work that OpusClip can't do: original UGC, photo slideshows, or edits built around a required song. The platform should pick campaigns it can actually serve instead of ingesting everything.
2. **Footage lives in many places, and there's often more than one per campaign.** Google Drive is the most common, followed by YouTube channels, Dropbox, files uploaded to Content Rewards itself, Frame.io, Kick, MediaSilo, Notion pages and custom sites.
3. **Footage links appear in three places:** the campaign's `referenceMaterials`, hyperlinks inside the guideline doc, and pages linked from the doc (Notion, second Google Docs). No single field says "this is the footage".
4. **Folders mix footage with other assets.** Real Drive folders contain subfolders like `Raw to edit`, `B-rolls for clippers`, `Podcast RZ Experience`, `Memes Only`, `Nilo Logos = UI Elements` and `Static Assets / Still Image`. Picking the right subfolder is a reading-comprehension task, not a parsing task.
5. **Some source rules can't be expressed as a folder.** Gattouz × 1win: "We no longer provide a clip package. You need to clip the content yourself from YouTube (with 1win merch) and Kick." Picking qualifying videos takes judgment.
6. **Public Drive folders can be listed without an API key.** `https://drive.google.com/embeddedfolderview?id={folderId}` returns file and subfolder names for any link-shared folder. Verified on 4 campaign folders.
7. **OpusClip ingests most of the footage hosts directly.** Its create-project docs list YouTube, Google Drive, Dropbox, Frame.io, Loom, Twitch, Vimeo, Rumble and more, plus any public S3 MP4 link. That covers files uploaded to Content Rewards, which sit in a public S3 bucket. Kick, MediaSilo, Notion and custom sites are **not** supported.

## Campaign types

| Type | Count | What the clipper does | OpusClip fit |
|---|---|---|---|
| **Long-form → clips** | 31 | Cut a creator's streams, podcasts, specials or gameplay into shorts | ✅ Core use case |
| **UGC / original content** | 7 | Film or record new content (persona pages, gameplay, split-screen) | ❌ |
| **Music / audio** | 4 | Edit any content over a required TikTok/IG sound | ❌ (needs an audio swap OpusClip doesn't do) |
| **Photo slideshow** | 2 | Native TikTok photo carousels | ❌ |
| **Unclear from public data** | 6 | Rules are in a Notion page or there are no links at all | Needs a human or Claude read |

## Footage hosts among the 31 long-form campaigns

A campaign can have several. Counts are campaigns, not links.

| Host | Campaigns | Shape | OpusClip ingest | How we list it |
|---|---|---|---|---|
| Google Drive folder | 20 | Folder, often nested and mixed-purpose | ✅ per file | Keyless `embeddedfolderview`, recursive |
| Google Drive file | 3 | Single file link | ✅ | Direct |
| YouTube channel | 7 | `@handle`, clipper chooses videos | ✅ per video | Channel RSS feed (`/feeds/videos.xml?channel_id=`), no key; most recent 15 videos |
| Dropbox folder/file | 4 | `scl/fo` shared folders; one is a private `/home/...` path | ✅ per file | Unverified: start with human-picked file links |
| Content Rewards uploads | 2 | Public S3 MP4 in `referenceMaterials` (`type: video`) | ✅ (S3 MP4) | Direct, already structured |
| Frame.io | 1 | Share link | ✅ | Direct |
| Kick | 2 | Live channel | ❌ | Human |
| MediaSilo | 1 (MW4) | Review link | ❌ | Human |
| Custom content site | 1 | Content portal (Notion-only campaigns are counted as Unclear) | ❌ | Human |

## Per-campaign classification

`LF` = long-form → clips. Footage hosts are from `referenceMaterials` and doc links.

| # | Campaign | Type | Footage |
|---|---|---|---|
| 0 | Michael Sartain's Clipping Army | LF | YouTube channel |
| 1 | Shuffle Streamers (application) | LF | CR uploads + 2 Drive folders |
| 2 | Yomi Denzel (application) | LF | Drive folder |
| 3 | ForgeGUI [Roblox] | LF | Drive folder |
| 4 | Goli NAD+ × Target | UGC | — |
| 5 | Lovable Clipping | Unclear | Notion page |
| 6 | RobTheBank Clips | LF | 3 Drive folders + private Dropbox path |
| 7 | Daimon X Syndicate | Unclear | no links |
| 8 | DreamMe | Slideshow | — |
| 9 | Clipback $CLIP | LF | CR uploads |
| 10 | WatchMeWin | LF | Drive folder |
| 11 | Split-Screen UGC | UGC | — |
| 12 | Alpha Futures | LF | custom content site |
| 13 | Rolling Loud Movie | LF | Drive folder (5 MP4s) |
| 14 | Coinpoker Logo | LF | Drive folder (logo overlay assets) |
| 15 | TrendStory | Unclear | app site |
| 16 | Syberjet Speed Record | LF | Drive folder + CR images |
| 17 | Coinbase × Valorant | Unclear | Notion rules page |
| 18 | INOUT Games | UGC | record own gameplay |
| 19 | Scroll The Bible | UGC | app promo |
| 20 | Elo Cooking | Slideshow | — |
| 21 | Matt Hazen (application) | LF | no links (creator's channel implied) |
| 22 | Carlos Esparraga (application) | LF | Drive folder |
| 23 | Charlie Berens | LF | Drive folder (2 full specials) |
| 24 | The Candid Club | LF | Drive folder |
| 25 | PULP | LF | 2 Drive folders + 4 sub-docs |
| 26 | Graeme Holm | LF | YouTube channel |
| 27 | Abu Lahya | LF | Frame.io (+ Loom walkthrough) |
| 28 | BLINKxLIZ | Unclear | Notion page |
| 29 | Carlotta Sabina | Unclear | no links |
| 30 | UGC Repurposing | UGC | — |
| 31 | Gattouz × 1win | LF | YouTube (with a content filter) + Kick |
| 32 | Hello Nancy | LF | Drive folder + 5 Drive files |
| 33 | Leon Bridges – Fallon | LF | Dropbox folder |
| 34 | Mario Vincere | LF | Drive folder |
| 35 | Up Next Fighting | LF | 3 Drive files + YouTube channel |
| 36 | Eneba | UGC | — |
| 37 | Kluster Flux | Music | required audio |
| 38 | Kevin Furest | LF | 2 Drive folders + Drive file + YouTube |
| 39 | Ryan Zofay | LF | Drive folder (`Raw to edit`, `B-rolls`, `Podcast`) |
| 40 | Dardan | Music | required audio |
| 41 | Antoine Sallis | LF | Drive folder + Dropbox folder |
| 42 | Ali-A Fortnite | UGC | — |
| 43 | No Tomorrow | Music | required audio |
| 44 | DumbMoneyHunter (application) | LF | Drive folder + YouTube + Kick |
| 45 | Social Commerce News | LF | Dropbox folder (podcast) |
| 46 | Nilo.io | LF | Drive folder (7 purpose-named subfolders) |
| 47 | Mac Mula | LF | YouTube channel |
| 48 | REIGN | LF | 2 Drive folders |
| 49 | Late Checkout | Music | required audio |
| — | MW4 (paused, planning reference) | LF | MediaSilo (linked only from the doc) |

## Other observations that affect the design

- **6 of 50 require an application.** Joining any campaign is an account action on Content Rewards and must stay with a human.
- **Brief rules that code can check:** required tags (`@callofduty`), exact caption phrases ("Pre-order Modern Warfare 4 today…"), FTC disclosure on its own line, dedicated-page requirements, audience-tier minimums, minimum views, "must stay live 30 days".
- **Brief rules that need judgment:** "don't make the brand look bad", "pick the strongest moments", "only videos with 1win merch", "gameplay must appear by the 4-second mark".
- **Guideline docs link to other docs** (PULP links 4 more Google Docs, DreamMe links Notion guides). Reading the brief means following links.
- **Descriptions on the individual campaign page are often empty.** The listing page's `description` is more reliable for triage.
