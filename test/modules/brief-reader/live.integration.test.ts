import { describe, expect, it } from "vitest";
import { readGoogleDoc, readNotionPage } from "../../../src/modules/brief-reader/index.js";

// Real campaign briefs from the survey (docs/CAMPAIGN_SURVEY.md #25 PULP, #39 Ryan Zofay).
// Run with RUN_NETWORK_TESTS=1.
describe.skipIf(!process.env.RUN_NETWORK_TESTS)("brief-reader against live Google Docs", () => {
  it.each([
    ["PULP (#25)", "1NrqvbTIf2EY_k5r6zR4BOHNxZxvLIm2h", "15u7x8jqub-qTImfMmTcm3fgOYSZTbby5"],
    ["Ryan Zofay (#39)", "1tsGFWUiRZjUcASvtN8x5oxs2HMOKeect5xZTbj81faU", "1g2wgEVd9BT4bFhKxR3Jztd6b5kywaE4s"],
  ])("%s brief includes its Drive folder link", { timeout: 30_000 }, async (_name, docId, folderId) => {
    const doc = await readGoogleDoc(`https://docs.google.com/document/d/${docId}/edit`);
    expect(doc.links.map((l) => l.url)).toContainEqual(expect.stringContaining(`drive.google.com/drive/folders/${folderId}`));
    expect(doc.text).toContain(folderId);
    expect(doc.text.length).toBeGreaterThan(1000);
  });

  it("finds a folder that the plain-text export loses (PULP links it from the words 'PULP Assets Folder')", { timeout: 30_000 }, async () => {
    const docId = "1NrqvbTIf2EY_k5r6zR4BOHNxZxvLIm2h";
    const folderId = "15u7x8jqub-qTImfMmTcm3fgOYSZTbby5";
    const plain = await (await fetch(`https://docs.google.com/document/d/${docId}/export?format=txt`)).text();
    expect(plain).not.toContain(folderId);
    const doc = await readGoogleDoc(`https://docs.google.com/document/d/${docId}/edit`);
    expect(doc.text).toContain(`PULP Assets Folder <https://drive.google.com/drive/folders/${folderId}>`);
  });
});

// Real Notion rules pages from scouting (2026-09-30). Run with RUN_NETWORK_TESTS=1.
describe.skipIf(!process.env.RUN_NETWORK_TESTS)("brief-reader against live Notion pages", () => {
  it("reads Curious Mike's rules, including the text inside its collapsed dropdown headings", { timeout: 60_000 }, async () => {
    const page = await readNotionPage(
      "https://ultra-allspice-171.notion.site/Curious-Mike-Clipping-Campaign-Guidelines-3e2f23112cb081d0aa31d058376acc1d",
    );
    expect(page.title).toBe("Curious Mike Clipping Campaign Guidelines");
    // Both lines sit inside collapsed toggle headings that loadPageChunk alone doesn't return.
    expect(page.text).toContain("No Opus Clips or any auto-clipping tool");
    expect(page.text).toContain("Trae Young <https://youtu.be/uf0q07QagUs>");
    expect(page.links.map((l) => l.url)).toContain("https://youtu.be/mx2XmltF8ZE");
  });

  it("reads an app.notion.com link (Coinbase × Valorant)", { timeout: 60_000 }, async () => {
    const page = await readNotionPage("https://app.notion.com/p/RIOT-GAMES-VALORANT-CLIPPING-RULES-3e10395e47eb80b4966eefb0fcd3c0e8?source=copy_link");
    expect(page.text.length).toBeGreaterThan(1000);
    expect(page.links.map((l) => l.url)).toContainEqual(expect.stringContaining("dropbox.com"));
  });
});
