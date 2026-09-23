import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FootageError, listFootageUrl, parseYouTubeFeed } from "../../../src/modules/footage-sources/index.js";

const drive: Record<string, string> = JSON.parse(
  readFileSync(new URL("../../fixtures/drive-folders.json", import.meta.url), "utf8"),
);
const feed = readFileSync(new URL("../../fixtures/youtube-feed.xml", import.meta.url), "utf8");

/** Serves the fixture folder tree: FOLDER_PRIVATE is private (404), anything unknown is 404. */
function driveFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const id = new URL(String(input)).searchParams.get("id")!;
    const body = drive[id];
    return new Response(body ?? "", { status: body ? 200 : 404 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("listFootageUrl: Google Drive folders", () => {
  it("lists recursively with folder paths, telling videos from other files", async () => {
    const l = await listFootageUrl("https://drive.google.com/drive/folders/ROOT?usp=sharing", { fetch: driveFetch() });
    expect(l).toMatchObject({ kind: "gdrive_folder", role: "folder", listable: true });
    expect(l.folders.map((f) => f.path)).toEqual(["Raw to edit", "B-rolls for clippers", "Team only", "Raw to edit/Day 1"]);
    expect(l.entries.map((e) => [e.path, e.name, e.isVideo, e.sourceKey])).toEqual([
      ["", "CAMPAIGN GUIDE", false, null],
      ["", "Full Special (1080p) & Extras.mp4", true, "gdrive:VID_TOP"],
      ["Raw to edit", "Episode 1.mov", true, "gdrive:VID_RAW1"],
      ["B-rolls for clippers", "logo.png", false, null],
      ["B-rolls for clippers", "city.mp4", true, "gdrive:VID_BROLL"],
      ["Raw to edit/Day 1", "clip.mkv", true, "gdrive:VID_DAY1"], // no video mime; the extension decides
    ]);
    expect(l.entries[1]).toMatchObject({ url: "https://drive.google.com/file/d/VID_TOP/view", mimeType: "video/mp4" });
  });

  it("stops at the depth limit and says so", async () => {
    const { listFootageUrl: list } = await import("../../../src/modules/footage-sources/list.js");
    const l = await list("https://drive.google.com/drive/folders/ROOT", { fetch: driveFetch() }, { maxDepth: 1 });
    expect(l.entries.map((e) => e.name)).not.toContain("clip.mkv");
    expect(l.note).toMatch(/depth 1/);
  });

  it("reports a missing or private root folder as not_accessible", async () => {
    await expect(listFootageUrl("https://drive.google.com/drive/folders/NOPE", { fetch: driveFetch() })).rejects.toMatchObject({
      code: "not_accessible",
    });
  });
});

describe("listFootageUrl: YouTube channels", () => {
  it("parses the feed, marking Shorts", () => {
    const entries = parseYouTubeFeed(feed);
    expect(entries).toEqual([
      expect.objectContaining({ sourceKey: "youtube:AAAAAAAAAAA", name: "Short: best moment & reaction #shorts", isShort: true, views: 38 }),
      expect.objectContaining({
        sourceKey: "youtube:BBBBBBBBBBB",
        url: "https://www.youtube.com/watch?v=BBBBBBBBBBB",
        isShort: false,
        description: "Two hours with the crew. Sponsored by 1win.",
        publishedAt: "2026-09-20T12:00:00+00:00",
      }),
    ]);
  });

  it("resolves an @handle via the page's canonical link, not featured channels", async () => {
    const page = `<html><script>{"channelId":"UCfeaturedAAAAAAAAAAAAAAA"}</script><link rel="canonical" href="https://www.youtube.com/channel/UCownchannelBBBBBBBBBBBB"></html>`;
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("feeds/videos.xml") ? new Response(feed) : new Response(page),
    ) as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>;
    const l = await listFootageUrl("https://www.youtube.com/@creator", { fetch });
    expect(fetch).toHaveBeenLastCalledWith(
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCownchannelBBBBBBBBBBBB",
      expect.anything(),
    );
    expect(l.entries).toHaveLength(2);
    expect(l.note).toMatch(/most recent/);
  });
});

describe("listFootageUrl: other links", () => {
  const noFetch = vi.fn() as unknown as typeof fetch;

  it("returns a single entry for a file link without fetching", async () => {
    const l = await listFootageUrl("https://youtu.be/cG8thOSLmTY", { fetch: noFetch });
    expect(l).toMatchObject({ role: "file", entries: [{ sourceKey: "youtube:cG8thOSLmTY", isVideo: true }] });
    expect(noFetch).not.toHaveBeenCalled();
  });

  it("marks Dropbox folders as not listable, with guidance", async () => {
    const l = await listFootageUrl("https://www.dropbox.com/scl/fo/abc/def?rlkey=x&dl=0", { fetch: noFetch });
    expect(l).toMatchObject({ listable: false, entries: [], note: expect.stringMatching(/file links/) });
  });

  it("refuses unsupported hosts with the reason", async () => {
    await expect(listFootageUrl("https://kick.com/x", { fetch: noFetch })).rejects.toBeInstanceOf(FootageError);
    await expect(listFootageUrl("https://kick.com/x", { fetch: noFetch })).rejects.toMatchObject({
      code: "unsupported_host",
      message: expect.stringContaining("Kick"),
    });
  });
});
