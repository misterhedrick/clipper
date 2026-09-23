import { describe, expect, it } from "vitest";
import { readGoogleDoc } from "../../../src/modules/brief-reader/index.js";

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
