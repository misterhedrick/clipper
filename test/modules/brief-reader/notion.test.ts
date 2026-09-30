import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BriefReaderError,
  briefDocId,
  collectNotionBlocks,
  isBriefDocUrl,
  missingNotionBlocks,
  parseNotionPageUrl,
  readBriefDoc,
  readNotionPage,
  renderNotionPage,
} from "../../../src/modules/brief-reader/index.js";

// Synthetic page in the shape of Notion's loadPageChunk response, split over two
// chunks: both record nestings, rich text with bold/code/links, mentions (page,
// date, link preview), a callout, nested bullets, a table, a child page, a toggle,
// a bookmark, an attachment image and a deleted block.
// `synced` holds blocks loadPageChunk leaves out (the contents of a collapsed toggle
// heading), served by the syncRecordValues mock below.
const fixture = JSON.parse(readFileSync(new URL("../../fixtures/notion-load-page-chunk.json", import.meta.url), "utf8")) as {
  chunks: { cursor: { stack: unknown[] }; recordMap: unknown }[];
  synced: Record<string, unknown>;
};
const PAGE_ID = "11111111-2222-3333-4444-555555555555";
const PAGE_URL = "https://example-site.notion.site/Example-Clipping-Guidelines-11111111222233334444555555555555";

describe("renderNotionPage", () => {
  const blocks = collectNotionBlocks(fixture.chunks.map((c) => c.recordMap));
  const { title, text, links } = renderNotionPage(PAGE_ID, blocks);

  it("renders the title, then blocks in page order, with links inline", () => {
    expect(title).toBe("Example Clipping Guidelines");
    // The first block is a child page: it's listed as a link, never expanded as if it were the page.
    expect(text).toMatch(/^Example Clipping Guidelines\n\nCaption examples <https:\/\/www\.notion\.so\/0{31}9>\nCampaign details\n/);
    expect(text).toContain("Pays $1.25 per 1K views. Rules: see the caption guide <https://docs.google.com/document/d/SUBDOC1/edit>.");
    expect(text).toContain("⚠️\nTag @example in every caption.");
    expect(text).toContain("- Clips 15–60s\n  - No music under speech");
  });

  it("renders table rows in column order and says a link preview needs the page", () => {
    expect(text).toContain("Episode | Where\nTrae Young | Watch it <https://youtu.be/EPISODE1> · also [link preview: open the page to see it]");
  });

  it("renders mentions, child pages, toggles and bookmarks; skips attachments and deleted blocks", () => {
    expect(text).toContain("More in FAQ <https://www.notion.so/99999999888877776666555555555555> by 2026-10-01");
    expect(text).toContain("Caption examples <https://www.notion.so/00000000000000000000000000000009>");
    expect(text).not.toContain("child page body");
    expect(text).toContain("FAQ: can I add music?\n  No.");
    expect(text).toContain("Footage folder <https://www.dropbox.com/scl/fi/EP1.mp4>");
    expect(text).not.toMatch(/attachment:|cover\.png|deleted line|\n{3,}/);
  });

  it("names the blocks still to fetch: under the page and its toggles, not inside child pages", () => {
    expect(missingNotionBlocks(PAGE_ID, blocks)).toEqual([
      "00000000-0000-0000-0000-000000000050",
      "00000000-0000-0000-0000-000000000051",
    ]);
  });

  it("lists distinct links in page order", () => {
    expect(links.map((l) => l.url)).toEqual([
      "https://www.notion.so/00000000000000000000000000000009",
      "https://docs.google.com/document/d/SUBDOC1/edit",
      "https://youtu.be/EPISODE1",
      "https://www.notion.so/99999999888877776666555555555555",
      "https://www.dropbox.com/scl/fi/EP1.mp4",
    ]);
  });
});

describe("parseNotionPageUrl", () => {
  it("takes the page ID from notion.site, notion.so and app.notion.com links", () => {
    expect(parseNotionPageUrl(PAGE_URL)).toBe(PAGE_ID);
    expect(parseNotionPageUrl("https://www.notion.so/team/Rules-11111111222233334444555555555555?pvs=4")).toBe(PAGE_ID);
    expect(parseNotionPageUrl("https://app.notion.com/p/RULES-11111111-2222-3333-4444-555555555555?source=copy_link")).toBe(PAGE_ID);
  });

  it("refuses other hosts, lookalikes and pages without an ID", () => {
    expect(parseNotionPageUrl("https://docs.google.com/document/d/11111111222233334444555555555555/edit")).toBeNull();
    expect(parseNotionPageUrl("https://notion.site.evil.com/x-11111111222233334444555555555555")).toBeNull();
    expect(parseNotionPageUrl("http://www.notion.so/x-11111111222233334444555555555555")).toBeNull();
    expect(parseNotionPageUrl("https://www.notion.so/product")).toBeNull();
    expect(parseNotionPageUrl("not a url")).toBeNull();
  });
});

/** Serves loadPageChunk from the fixture's chunks and syncRecordValues from its synced blocks. */
const notionApi = () =>
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      chunkNumber?: number;
      requests?: { pointer: { table: string; id: string; spaceId: string } }[];
    };
    if (String(url).endsWith("/syncRecordValues")) {
      const block = Object.fromEntries(
        (body.requests ?? []).filter((r) => fixture.synced[r.pointer.id]).map((r) => [r.pointer.id, fixture.synced[r.pointer.id]]),
      );
      return Response.json({ recordMap: { __version__: 3, block } });
    }
    return Response.json(fixture.chunks[body.chunkNumber!]);
  }) as unknown as typeof fetch;
const calls = (f: typeof fetch) =>
  (f as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => ({
    path: String(c[0]).split("/").pop(),
    body: JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>,
    headers: (c[1] as RequestInit).headers as Record<string, string>,
  }));

describe("readNotionPage", () => {
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(BriefReaderError);
      return (e as BriefReaderError).code;
    }
    return "resolved";
  };

  it("pages through loadPageChunk, passing the cursor, until the cursor is empty", async () => {
    const fetch = notionApi();
    const page = await readNotionPage(PAGE_URL, { fetch });
    const chunkCalls = calls(fetch).filter((c) => c.path === "loadPageChunk");
    expect(chunkCalls.map((c) => c.body)).toEqual([
      expect.objectContaining({ pageId: PAGE_ID, chunkNumber: 0, cursor: { stack: [] } }),
      expect.objectContaining({ pageId: PAGE_ID, chunkNumber: 1, cursor: fixture.chunks[0]!.cursor }),
    ]);
    // Cloudflare in front of Notion answers a request with no user agent with a 403.
    expect(chunkCalls[0]!.headers["user-agent"]).toMatch(/clipper/);
    expect(page).toMatchObject({ pageId: PAGE_ID, url: PAGE_URL, title: "Example Clipping Guidelines" });
    expect(page.text).toContain("Trae Young");
  });

  it("fetches what's inside collapsed toggles by ID, level by level, with the page's space ID", async () => {
    const fetch = notionApi();
    const page = await readNotionPage(PAGE_URL, { fetch });
    expect(page.text).toContain("The No list\n- No auto-clipping tools\n  - Not even for captions\nNo watermark, no payment.");
    const sync = calls(fetch).filter((c) => c.path === "syncRecordValues");
    const asked = sync.map((c) => (c.body.requests as { pointer: { id: string; spaceId: string } }[]).map((r) => r.pointer));
    expect(asked).toEqual([
      [
        { table: "block", id: "00000000-0000-0000-0000-000000000050", spaceId: "sp" },
        { table: "block", id: "00000000-0000-0000-0000-000000000051", spaceId: "sp" },
      ],
      [{ table: "block", id: "00000000-0000-0000-0000-000000000060", spaceId: "sp" }],
    ]);
    // Child pages' own content is never fetched.
    expect(asked.flat().map((p) => p.id)).not.toContain("00000000-0000-0000-0000-000000000040");
  });

  it("asks for a block that never arrives only once", async () => {
    const withoutSynced = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).endsWith("/syncRecordValues")
        ? Response.json({ recordMap: { __version__: 3 } })
        : Response.json(fixture.chunks[(JSON.parse(String(init?.body)) as { chunkNumber: number }).chunkNumber]),
    ) as unknown as typeof fetch;
    const page = await readNotionPage(PAGE_URL, { fetch: withoutSynced });
    expect(calls(withoutSynced).filter((c) => c.path === "syncRecordValues")).toHaveLength(1);
    expect(page.text).toContain("The No list");
  });

  it("reports an empty record map (private or deleted page) as not_public", async () => {
    const empty = vi.fn(async () => Response.json({ cursor: { stack: [] }, recordMap: { __version__: 3 } })) as unknown as typeof fetch;
    expect(await code(readNotionPage(PAGE_URL, { fetch: empty }))).toBe("not_public");
  });

  it("treats HTTP errors (Notion or Cloudflare refusing the request) and network failures as fetch_failed", async () => {
    const status = (s: number) => vi.fn(async () => new Response("", { status: s })) as unknown as typeof fetch;
    expect(await code(readNotionPage(PAGE_URL, { fetch: status(403) }))).toBe("fetch_failed");
    expect(await code(readNotionPage(PAGE_URL, { fetch: status(500) }))).toBe("fetch_failed");
    const broken = vi.fn(async () => {
      throw new TypeError("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await code(readNotionPage(PAGE_URL, { fetch: broken }))).toBe("fetch_failed");
    const odd = vi.fn(async () => Response.json({ nope: true })) as unknown as typeof fetch;
    expect(await code(readNotionPage(PAGE_URL, { fetch: odd }))).toBe("fetch_failed");
  });
});

describe("readBriefDoc", () => {
  it("routes Notion URLs to the Notion reader and tags the source", async () => {
    const doc = await readBriefDoc(PAGE_URL, { fetch: notionApi() });
    expect(doc).toMatchObject({ source: "notion", docId: PAGE_ID, url: PAGE_URL });
  });

  it("refuses anything that isn't a Google Doc or Notion page", async () => {
    await expect(readBriefDoc("https://drive.google.com/drive/folders/x")).rejects.toMatchObject({ code: "unsupported_doc" });
    expect(isBriefDocUrl("https://drive.google.com/drive/folders/x")).toBe(false);
    expect(isBriefDocUrl(PAGE_URL)).toBe(true);
    expect(briefDocId("https://docs.google.com/document/d/DOC1/edit")).toBe("DOC1");
    expect(briefDocId(PAGE_URL)).toBe(PAGE_ID);
  });
});
