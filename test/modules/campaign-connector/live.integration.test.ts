import { describe, expect, it } from "vitest";
import { fetchCampaign, resolveCampaignId } from "../../../src/modules/campaign-connector/index.js";

// Hits the real Content Rewards site. Skipped by default; run with
//   RUN_NETWORK_TESTS=1 npm test -- live
// This is the canary for Content Rewards changing their page markup.
const ID = "24ad920b-d24f-479e-9cef-f22182e4a0c0";

describe.skipIf(!process.env.RUN_NETWORK_TESTS)("campaign-connector against live Content Rewards", () => {
  it("resolves the /campaigns/{id} redirect", async () => {
    expect(await resolveCampaignId(`https://contentrewards.com/campaigns/${ID}`)).toBe(ID);
  });

  it("parses the MW4 reference campaign", { timeout: 30_000 }, async () => {
    const campaign = await fetchCampaign(`https://contentrewards.com/discover/${ID}`);
    expect(campaign.campaignId).toBe(ID);
    expect(campaign.title).toMatch(/Modern Warfare 4/);
    expect(campaign.platforms.length).toBeGreaterThan(0);
    expect(campaign.payouts.length).toBeGreaterThan(0);
    expect(campaign.payouts.every((p) => typeof p.rateCents === "number")).toBe(true);
    expect(campaign.guidelineDocId).toBeTruthy();
    // This campaign has no Drive folder in its reference materials (footage is linked from the doc).
    expect(campaign.driveFolderUrl === null || campaign.driveFolderId !== null).toBe(true);
  });
});
