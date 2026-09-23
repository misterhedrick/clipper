import { describe, expect, it } from "vitest";
import { classifyFootageUrl } from "../../../src/modules/footage-sources/index.js";

describe("classifyFootageUrl", () => {
  it.each([
    ["https://drive.google.com/drive/folders/1g2wgEVd9BT4bFhKxR3Jztd6b5kywaE4s?usp=sharing", "folder", "gdrive_folder"],
    ["https://drive.google.com/drive/u/1/folders/1TU0zp1NO53vP47Ge2HRdh5c6yVTbyqoT?usp=x", "folder", "gdrive_folder"],
    ["https://www.youtube.com/@MacMula", "channel", "youtube_channel"],
    ["https://youtube.com/channel/UCok9KF872WqJEP1LbJRRv6A", "channel", "youtube_channel"],
    ["https://www.dropbox.com/scl/fo/981kxofartswg4z33z2te/ANQD0EBGPEUNmuPWOcaRidU?rlkey=abc&dl=0", "folder", "dropbox"],
  ])("%s → %s", (url, role, kind) => {
    expect(classifyFootageUrl(url)).toMatchObject({ role, kind });
  });

  it.each([
    ["https://drive.google.com/file/d/1LR2nEx8g7XgAXs2xfBtWAN5-H_ccdllS/view?usp=sharing", "gdrive:1LR2nEx8g7XgAXs2xfBtWAN5-H_ccdllS", "https://drive.google.com/file/d/1LR2nEx8g7XgAXs2xfBtWAN5-H_ccdllS/view"],
    ["https://drive.google.com/open?id=FILEID123", "gdrive:FILEID123", "https://drive.google.com/file/d/FILEID123/view"],
    ["https://www.youtube.com/watch?v=spOmWw5ScDs&t=30", "youtube:spOmWw5ScDs", "https://www.youtube.com/watch?v=spOmWw5ScDs"],
    ["https://youtu.be/cG8thOSLmTY?si=abc", "youtube:cG8thOSLmTY", "https://www.youtube.com/watch?v=cG8thOSLmTY"],
    ["https://www.youtube.com/shorts/wIVKkjmN0-A", "youtube:wIVKkjmN0-A", "https://www.youtube.com/watch?v=wIVKkjmN0-A"],
    ["https://www.loom.com/share/6ac4dc2e07e0401cb78992a68c07be94", "loom:6ac4dc2e07e0401cb78992a68c07be94", "https://www.loom.com/share/6ac4dc2e07e0401cb78992a68c07be94"],
    ["https://vimeo.com/123456789", "vimeo:123456789", "https://vimeo.com/123456789"],
    ["https://www.twitch.tv/videos/2222", "twitch:2222", "https://www.twitch.tv/videos/2222"],
  ])("%s → file %s", (url, sourceKey, videoUrl) => {
    expect(classifyFootageUrl(url)).toEqual({ role: "file", kind: expect.any(String), url, sourceKey, videoUrl });
  });

  it("keys hashed hosts on a normalized URL, so tracking params don't create duplicates", () => {
    const a = classifyFootageUrl("https://bucket.s3.us-east-1.amazonaws.com/org/campaigns/v.mp4?X-Amz-Date=1");
    const b = classifyFootageUrl("https://bucket.s3.us-east-1.amazonaws.com/org/campaigns/v.mp4");
    expect(a).toMatchObject({ role: "file", kind: "s3_mp4" });
    expect(a.role === "file" && b.role === "file" && a.sourceKey === b.sourceKey).toBe(true);

    const d1 = classifyFootageUrl("https://www.dropbox.com/scl/fi/abc/talk.mp4?rlkey=K&dl=0");
    const d2 = classifyFootageUrl("https://www.dropbox.com/scl/fi/abc/talk.mp4?rlkey=K&dl=1");
    expect(d1.role === "file" && d2.role === "file" && d1.sourceKey === d2.sourceKey).toBe(true);
    expect(d1).toMatchObject({ videoUrl: "https://www.dropbox.com/scl/fi/abc/talk.mp4?rlkey=K" });

    const f = classifyFootageUrl("https://next.frame.io/share/4da67ff0-c19f-4daf-8a8a-76fbcbf1c26c/");
    expect(f).toMatchObject({ role: "file", kind: "frameio" });
  });

  it.each([
    ["https://kick.com/gattouz0", /Kick/],
    ["https://app.mediasilo.com/review/6a88a6c15a183a21eeeae9e6", /MediaSilo/],
    ["https://mediamaxxing.notion.site/lovable-clipping", /Notion/],
    ["https://www.dropbox.com/home/Rob's%20Social%20Media%20Suite/1.%20YouTube%20Videos/", /private Dropbox/],
    ["https://www.twitch.tv/somestreamer", /VOD/],
    ["https://docs.google.com/document/d/abc/edit", /Google Doc/],
    ["https://www.instagram.com/carlos_espaarraga4/", /social/],
    ["https://content.clipalphafutures.com/", /unrecognized host/],
    ["not a url", /not a URL/],
  ])("%s is unsupported (%s)", (url, reason) => {
    const c = classifyFootageUrl(url);
    expect(c.role).toBe("unsupported");
    expect(c.role === "unsupported" && c.reason).toMatch(reason);
  });
});
