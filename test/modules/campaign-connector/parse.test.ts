import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CampaignConnectorError,
  extractRscPayload,
  findCampaignObject,
  parseCampaignIdFromUrl,
  parseCampaignPageHtml,
  parseDriveFolderId,
  parseGoogleDocId,
} from "../../../src/modules/campaign-connector/parse.js";

const ID = "24ad920b-d24f-479e-9cef-f22182e4a0c0";
// Trimmed capture of the live /discover/{id} page (2026-09-22): real campaign object,
// with `metrics` removed, split across two stream chunks, plus a decoy prop carrying the ID.
const fixtureHtml = readFileSync(new URL("../../fixtures/content-rewards-campaign-page.html", import.meta.url), "utf8");

const rscPage = (...chunks: string[]) =>
  chunks.map((c) => `<script>self.__next_f.push(${JSON.stringify([1, c])})</script>`).join("");

describe("parseCampaignIdFromUrl", () => {
  it.each([
    [`https://contentrewards.com/discover/${ID}`],
    [`https://www.contentrewards.com/discover/${ID}?ref=abc`],
    [`https://contentrewards.com/campaigns/${ID}`],
    [`https://contentrewards.com/discover/${ID}/join`],
    [`  https://contentrewards.com/discover/${ID.toUpperCase()}  `],
  ])("extracts the ID from %s", (url) => {
    expect(parseCampaignIdFromUrl(url)).toBe(ID);
  });

  it("returns null for other Content Rewards URLs so the caller can follow redirects", () => {
    expect(parseCampaignIdFromUrl("https://contentrewards.com/c/some-slug")).toBeNull();
    expect(parseCampaignIdFromUrl("https://contentrewards.com/discover/not-a-uuid")).toBeNull();
  });

  it.each([["not a url"], ["https://evil.example.com/discover/" + ID], ["https://contentrewards.com.evil.io/discover/" + ID]])(
    "rejects %s as invalid_url",
    (url) => {
      expect(() => parseCampaignIdFromUrl(url)).toThrow(expect.objectContaining({ code: "invalid_url" }));
    },
  );
});

describe("Google URL helpers", () => {
  it("extracts doc and folder IDs", () => {
    expect(parseGoogleDocId("https://docs.google.com/document/d/1AaB-c_9/edit?usp=sharing")).toBe("1AaB-c_9");
    expect(parseDriveFolderId("https://drive.google.com/drive/folders/1xYz_-9?usp=sharing")).toBe("1xYz_-9");
    expect(parseDriveFolderId("https://drive.google.com/drive/u/0/folders/abc")).toBe("abc");
    expect(parseDriveFolderId("https://drive.google.com/file/d/abc/view")).toBeNull();
  });
});

describe("findCampaignObject", () => {
  it("returns the object whose own top-level id matches, not an inner or sibling one", () => {
    const payload = `x:{"campaignId":"${ID}"}\ny:{"card":{"banner":"a{b}","id":"${ID}","nested":{"id":"other"},"name":"N"}}`;
    expect(findCampaignObject(payload, ID)).toMatchObject({ id: ID, name: "N" });
  });

  it("ignores braces and quotes inside strings", () => {
    const payload = `{"card":{"description":"use {braces} and \\"quotes\\" }}}","id":"${ID}","name":"N"}}`;
    expect(findCampaignObject(payload, ID)).toMatchObject({ name: "N" });
  });

  it("returns null when the id only appears under a different key", () => {
    expect(findCampaignObject(`{"campaignId":"${ID}"}`, ID)).toBeNull();
  });
});

describe("extractRscPayload", () => {
  it("concatenates string chunks and skips non-string pushes", () => {
    const html = `<script>self.__next_f.push([0])</script>${rscPage("ab", "cd")}`;
    expect(extractRscPayload(html)).toBe("abcd");
  });
});

describe("parseCampaignPageHtml", () => {
  it("parses the captured live page", () => {
    const campaign = parseCampaignPageHtml(fixtureHtml, ID);
    expect(campaign).toMatchObject({
      campaignId: ID,
      title: "Call of Duty - Modern Warfare 4 Multiplayer Beta Gameplay Clipping",
      brand: "Clipping Culture",
      platforms: ["instagram", "tiktok", "youtube"],
      sourceStatus: "paused",
      payoutType: "cpm",
      isPrivate: false,
      requiresApplication: false,
      guidelineDocUrl: "https://docs.google.com/document/d/1AaBbbXTwpIOueM0kFdMC1xB7Leh0Jq3T9C-i6Zowxk4/edit?usp=sharing",
      guidelineDocId: "1AaBbbXTwpIOueM0kFdMC1xB7Leh0Jq3T9C-i6Zowxk4",
      // This campaign links its footage (MediaSilo) from inside the guideline doc, not as a Drive folder.
      driveFolderUrl: null,
      driveFolderId: null,
    });
    expect(campaign.payouts).toContainEqual({
      platform: "tiktok",
      payoutType: "cpm",
      rateCents: 175,
      minPayoutCents: 350,
      maxPayoutCents: 250000,
    });
    expect(campaign.budgetCents).toBeGreaterThan(0);
  });

  it("picks up a Drive folder from reference materials when present", () => {
    const card = {
      id: ID,
      name: "N",
      referenceMaterials: [
        { type: "brandAsset", mediaType: "external", url: "https://docs.google.com/document/d/DOC/edit" },
        { type: "brandAsset", mediaType: "external", url: "https://drive.google.com/drive/folders/FOLDER?usp=sharing" },
        { type: "brandAsset", mediaType: "external", url: null },
      ],
    };
    const campaign = parseCampaignPageHtml(rscPage(`1:{"card":${JSON.stringify(card)}}`), ID);
    expect(campaign).toMatchObject({ guidelineDocId: "DOC", driveFolderId: "FOLDER", platforms: [], payouts: [] });
    expect(campaign.referenceMaterials).toHaveLength(2);
  });

  it.each([
    ["a page with no RSC payload", "<html></html>"],
    ["a payload without the campaign", rscPage(`1:{"id":"someone-else"}`)],
    ["a campaign object missing its name", rscPage(`1:{"card":{"id":"${ID}"}}`)],
  ])("fails loudly with parse_failed on %s", (_label, html) => {
    let error: unknown;
    try {
      parseCampaignPageHtml(html, ID);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CampaignConnectorError);
    expect((error as CampaignConnectorError).code).toBe("parse_failed");
  });
});
