import { parseCampaignFromDiscoverHtml } from "./parseDiscoverPageHtml.js";
import type { CampaignMetadata } from "./types.js";

const USER_AGENT = "Mozilla/5.0 (compatible; ClipperBot/0.1; +internal campaign ingestion)";

export class CampaignConnectorError extends Error {}

/**
 * Accepts a `/discover/{id}` URL, a `/campaigns/{id}` URL (which redirects to
 * `/discover/{id}` — see API_CONTRACTS.md), or a bare campaign id.
 */
export async function resolveCampaignId(input: string): Promise<string> {
  const trimmed = input.trim();

  const discoverMatch = trimmed.match(/contentrewards\.com\/discover\/([a-zA-Z0-9-]+)/);
  if (discoverMatch) return discoverMatch[1];

  const campaignsMatch = trimmed.match(/contentrewards\.com\/campaigns\/([a-zA-Z0-9-]+)/);
  if (campaignsMatch) {
    const res = await fetch(`https://contentrewards.com/campaigns/${campaignsMatch[1]}`, {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
    });
    const location = res.headers.get("location");
    const resolved = location?.match(/\/discover\/([a-zA-Z0-9-]+)/);
    if (resolved) return resolved[1];
    throw new CampaignConnectorError(`Could not resolve campaign id from redirect for ${trimmed}`);
  }

  // Bare UUID-like id, already resolved.
  if (/^[a-zA-Z0-9-]+$/.test(trimmed)) return trimmed;

  throw new CampaignConnectorError(`Could not parse a campaign id from "${input}"`);
}

function driveFolderIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Fetches the campaign's discover page and extracts metadata + linked
 * guideline doc / drive folder. Throws CampaignConnectorError on any
 * failure — a hard failure here per ARCHITECTURE.md, not something to
 * guess around.
 */
export async function fetchCampaignMetadata(campaignId: string): Promise<CampaignMetadata> {
  const url = `https://contentrewards.com/discover/${campaignId}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new CampaignConnectorError(`Fetching ${url} returned HTTP ${res.status}`);
  }
  const html = await res.text();

  const parsed = parseCampaignFromDiscoverHtml(html, campaignId);
  if (!parsed) {
    throw new CampaignConnectorError(
      `Could not find campaign ${campaignId} in the discover page HTML — Content Rewards may have changed their page markup (see docs/API_CONTRACTS.md)`,
    );
  }

  return {
    campaignId,
    contentRewardsUrl: url,
    title: parsed.title ?? `Untitled campaign (${campaignId})`,
    brand: parsed.brand,
    platforms: parsed.platforms,
    payout: parsed.payout,
    guidelineDocUrl: parsed.guidelineDocUrl,
    driveFolderUrl: parsed.driveFolderUrl,
    driveFolderId: driveFolderIdFromUrl(parsed.driveFolderUrl),
  };
}
