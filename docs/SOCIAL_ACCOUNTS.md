# Social accounts

The accounts clips are posted to. Handles only: no passwords or tokens here.
Keep this current when an account is added, renamed or retired; campaign
routing (which campaign posts where) will point at these.

| Platform | Handle | Display name | Niche / used for | OpusClip account ID | Linked on Content Rewards |
|---|---|---|---|---|---|
| Instagram | [@hedrick.clips](https://www.instagram.com/hedrick.clips/) | hedrick.clips | General clipping (Boxabl first) | `6abadeddfcb3b882f21d6821` (Instagram Business, sub-account `17841433286283875`) | not yet checked |
| TikTok | [@hedrick.clips](https://www.tiktok.com/@hedrick.clips) | Hedrick Clips | General clipping (Boxabl first) | `6abae1f395d6ba3043cddc87` (TikTok Business; reconnected 2026-09-28 after the first connection turned out to be @danielhedrick721) | not yet checked |
| YouTube | [@hedrickclips](https://www.youtube.com/@hedrickclips) (no dot) | Daniel Hedrick | General clipping (Boxabl first), Shorts | `6abade79ae74eec7a3837564` (channel `UCJcCGg6ANkzY6c2b1GF9l9Q`) | not yet checked |

All three were new on 2026-09-28 (0 posts, 0 followers). Posting targets an account by its OpusClip account ID, not the handle; the IDs above were read with `opusclip_list_social_accounts` on 2026-09-28. Re-read them after reconnecting an account: a reconnect can change the ID. The posting code reads these IDs from `POST_ACCOUNTS` in `src/modules/posting/index.ts`: change both together.

Recorded 2026-09-28.
