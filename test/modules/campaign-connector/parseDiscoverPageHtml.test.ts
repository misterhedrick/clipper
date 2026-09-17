import { describe, expect, it } from "vitest";
import { parseCampaignFromDiscoverHtml } from "../../../src/modules/campaign-connector/parseDiscoverPageHtml.js";

/**
 * Minimal synthetic fixture mirroring the real page structure discovered
 * during implementation (see docs/API_CONTRACTS.md): a site-level
 * Organization ld+json block, a WebSite block, then the campaign's own
 * Product block, plus an RSC-style escaped fragment carrying platforms and
 * a guideline doc link. Not a full real page — just enough shape to prove
 * the extraction logic works without depending on network access in CI.
 */
function buildFixtureHtml(opts: { campaignId: string; includeDriveFolder: boolean }): string {
  const rscFragment = `["$","$L3c",null,{"card":{"id":"${opts.campaignId}","platforms":["instagram","tiktok","youtube"],"cpmMinRateCents":150,"cpmMaxRateCents":175,"budgetCents":10500000}}]`;
    // RSC payloads escape embedded quotes with backslashes.
  const escapedRsc = rscFragment.replace(/"/g, '\\"');

  const guidelineLink = "https://docs.google.com/document/d/EXAMPLE_DOC_ID/edit?usp=sharing";
  const driveLink = opts.includeDriveFolder
    ? "https://drive.google.com/drive/folders/EXAMPLE_FOLDER_ID?usp=sharing"
    : "";

  return `<!DOCTYPE html><html><head>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Content Rewards"}</script>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Content Rewards"}</script>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Example Campaign Title","description":"Example description","brand":{"@type":"Organization","name":"Example Brand"},"url":"https://contentrewards.com/discover/${opts.campaignId}"}</script>
    </head><body>
    <script>self.__next_f.push([1,"${escapedRsc} guideline: ${guidelineLink} ${driveLink}"])</script>
    </body></html>`;
}

describe("parseCampaignFromDiscoverHtml", () => {
  it("extracts title/brand/description from the Product ld+json block", () => {
    const html = buildFixtureHtml({ campaignId: "abc123", includeDriveFolder: true });
    const result = parseCampaignFromDiscoverHtml(html, "abc123");

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Example Campaign Title");
    expect(result?.brand).toBe("Example Brand");
    expect(result?.description).toBe("Example description");
  });

  it("extracts platforms and cpm/budget fields from the RSC fragment", () => {
    const html = buildFixtureHtml({ campaignId: "abc123", includeDriveFolder: true });
    const result = parseCampaignFromDiscoverHtml(html, "abc123");

    expect(result?.platforms).toEqual(["instagram", "tiktok", "youtube"]);
    expect(result?.payout).toEqual({ cpmMinRateCents: 150, cpmMaxRateCents: 175, budgetCents: 10500000 });
  });

  it("extracts the guideline doc URL", () => {
    const html = buildFixtureHtml({ campaignId: "abc123", includeDriveFolder: true });
    const result = parseCampaignFromDiscoverHtml(html, "abc123");

    expect(result?.guidelineDocUrl).toBe("https://docs.google.com/document/d/EXAMPLE_DOC_ID/edit?usp=sharing");
  });

  it("treats a missing drive folder link as a legitimate null, not a failure", () => {
    const html = buildFixtureHtml({ campaignId: "abc123", includeDriveFolder: false });
    const result = parseCampaignFromDiscoverHtml(html, "abc123");

    expect(result).not.toBeNull();
    expect(result?.driveFolderUrl).toBeNull();
  });

  it("extracts the drive folder URL when present", () => {
    const html = buildFixtureHtml({ campaignId: "abc123", includeDriveFolder: true });
    const result = parseCampaignFromDiscoverHtml(html, "abc123");

    expect(result?.driveFolderUrl).toBe("https://drive.google.com/drive/folders/EXAMPLE_FOLDER_ID?usp=sharing");
  });

  it("returns null when the campaign id isn't found on the page at all", () => {
    const html = buildFixtureHtml({ campaignId: "abc123", includeDriveFolder: true });
    const result = parseCampaignFromDiscoverHtml(html, "does-not-exist");

    expect(result).toBeNull();
  });
});
