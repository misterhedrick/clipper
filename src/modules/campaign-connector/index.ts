import {
  CampaignConnectorError,
  parseCampaignIdFromUrl,
  parseCampaignPageHtml,
  type CampaignMetadata,
} from "./parse.js";

export {
  CampaignConnectorError,
  parseDriveFolderId,
  parseGoogleDocId,
  type CampaignConnectorErrorCode,
  type CampaignMetadata,
  type CampaignPayout,
  type ReferenceMaterial,
} from "./parse.js";

const BASE_URL = "https://contentrewards.com";
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = "Mozilla/5.0 (compatible; clipper/0.1; +https://github.com/misterhedrick/clipper)";

export type ConnectorDeps = { fetch?: typeof fetch };

async function get(fetchImpl: typeof fetch, url: string): Promise<Response> {
  try {
    return await fetchImpl(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CampaignConnectorError("fetch_failed", `Request to ${url} failed: ${(err as Error).message}`);
  }
}

/**
 * Resolves any Content Rewards campaign URL to its campaign ID. `/discover/{id}` and
 * `/campaigns/{id}` are parsed directly; any other contentrewards.com URL is fetched
 * and the ID is read from where redirects land.
 */
export async function resolveCampaignId(url: string, deps: ConnectorDeps = {}): Promise<string> {
  const direct = parseCampaignIdFromUrl(url);
  if (direct) return direct;

  const res = await get(deps.fetch ?? fetch, url);
  const landed = parseCampaignIdFromUrl(res.url || url);
  if (!landed) {
    throw new CampaignConnectorError("invalid_url", `Could not find a campaign ID in ${url} or where it redirects`);
  }
  return landed;
}

/** Content Rewards URL → campaign metadata plus guideline doc / Drive folder references. */
export async function fetchCampaign(url: string, deps: ConnectorDeps = {}): Promise<CampaignMetadata> {
  const fetchImpl = deps.fetch ?? fetch;
  const campaignId = await resolveCampaignId(url, { fetch: fetchImpl });

  const pageUrl = `${BASE_URL}/discover/${campaignId}`;
  const res = await get(fetchImpl, pageUrl);
  if (res.status === 404) {
    throw new CampaignConnectorError("not_found", `Content Rewards has no campaign ${campaignId}`);
  }
  if (!res.ok) {
    throw new CampaignConnectorError("fetch_failed", `GET ${pageUrl} returned HTTP ${res.status}`);
  }
  return parseCampaignPageHtml(await res.text(), campaignId);
}
