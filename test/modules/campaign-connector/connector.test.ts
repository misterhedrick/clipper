import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fetchCampaign, resolveCampaignId } from "../../../src/modules/campaign-connector/index.js";

const ID = "24ad920b-d24f-479e-9cef-f22182e4a0c0";
const fixtureHtml = readFileSync(new URL("../../fixtures/content-rewards-campaign-page.html", import.meta.url), "utf8");

function fakeFetch(handler: (url: string) => { status?: number; body?: string; finalUrl?: string }) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const { status = 200, body = "", finalUrl = url } = handler(url);
    const res = new Response(body, { status });
    Object.defineProperty(res, "url", { value: finalUrl });
    return res;
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("resolveCampaignId", () => {
  it("does not hit the network for a direct campaign URL", async () => {
    const fetch = fakeFetch(() => ({}));
    expect(await resolveCampaignId(`https://contentrewards.com/campaigns/${ID}`, { fetch })).toBe(ID);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("follows redirects for other URL shapes", async () => {
    const fetch = fakeFetch(() => ({ finalUrl: `https://contentrewards.com/discover/${ID}` }));
    expect(await resolveCampaignId("https://contentrewards.com/c/mw4", { fetch })).toBe(ID);
  });

  it("fails with invalid_url when the redirect doesn't land on a campaign", async () => {
    const fetch = fakeFetch(() => ({ finalUrl: "https://contentrewards.com/discover" }));
    await expect(resolveCampaignId("https://contentrewards.com/c/gone", { fetch })).rejects.toMatchObject({ code: "invalid_url" });
  });
});

describe("fetchCampaign", () => {
  it("fetches the canonical discover page and parses it", async () => {
    const fetch = fakeFetch(() => ({ body: fixtureHtml }));
    const campaign = await fetchCampaign(`https://contentrewards.com/campaigns/${ID}`, { fetch });
    expect(fetch).toHaveBeenCalledWith(`https://contentrewards.com/discover/${ID}`, expect.anything());
    expect(campaign.title).toContain("Modern Warfare 4");
  });

  it.each([
    [404, "not_found"],
    [503, "fetch_failed"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const fetch = fakeFetch(() => ({ status }));
    await expect(fetchCampaign(`https://contentrewards.com/discover/${ID}`, { fetch })).rejects.toMatchObject({ code });
  });

  it("maps network errors to fetch_failed", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("getaddrinfo ENOTFOUND");
    }) as unknown as typeof globalThis.fetch;
    await expect(fetchCampaign(`https://contentrewards.com/discover/${ID}`, { fetch })).rejects.toMatchObject({
      code: "fetch_failed",
    });
  });
});
