import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CampaignConnectorError, parseDiscoverListingHtml } from "../../../src/modules/campaign-connector/parse.js";

// Trimmed capture of the live /discover listing (2026-09-22): three real campaign
// entries (images removed), split across stream chunks.
const fixture = readFileSync(new URL("../../fixtures/content-rewards-discover-listing.html", import.meta.url), "utf8");
const page = (...chunks: string[]) =>
  chunks.map((c) => `<script>self.__next_f.push(${JSON.stringify([1, c])})</script>`).join("");

describe("parseDiscoverListingHtml", () => {
  it("parses every campaign in the captured listing", () => {
    const campaigns = parseDiscoverListingHtml(fixture);
    expect(campaigns.map((c) => c.title)).toEqual([
      "Michael Sartain's Clipping Army",
      "Shuffle Streamers - Clipping",
      "Charlie Berens: Get paid 1$ per 1000 views",
    ]);
    expect(campaigns[0]).toMatchObject({
      campaignId: "86842687-ba2b-4638-a024-995dcf3d25a3",
      url: "https://contentrewards.com/discover/86842687-ba2b-4638-a024-995dcf3d25a3",
      brand: "Michael Sartain's Clipper Army",
      payoutType: "cpm",
      ratePer1k: 2,
      budgetTotal: 10000,
      requiresApplication: false,
    });
    expect(campaigns[0]!.description).toMatch(/podcasts, interviews, livestreams/);
    expect(campaigns[1]!.requiresApplication).toBe(true);
    expect(campaigns[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it.each([
    ["no payload", "<html></html>"],
    ["no campaigns array", page('1:{"other":[]}')],
    ["an empty listing", page('1:{"campaigns":[]}')],
    ["an entry without a title", page('1:{"campaigns":[{"id":"86842687-ba2b-4638-a024-995dcf3d25a3"}]}')],
  ])("fails loudly with parse_failed on %s", (_label, html) => {
    expect(() => parseDiscoverListingHtml(html)).toThrow(CampaignConnectorError);
    try {
      parseDiscoverListingHtml(html);
    } catch (e) {
      expect((e as CampaignConnectorError).code).toBe("parse_failed");
    }
  });
});
