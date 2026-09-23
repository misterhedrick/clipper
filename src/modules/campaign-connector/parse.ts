import { z } from "zod";

// Content Rewards has no public API. Everything in this file is reverse-engineered
// from the server-rendered discover page (see docs/API_CONTRACTS.md) and is the one
// place to fix when their frontend changes.

export type CampaignConnectorErrorCode =
  | "invalid_url" // not a Content Rewards campaign URL
  | "not_found" // Content Rewards returned 404 for the campaign
  | "fetch_failed" // network error or unexpected HTTP status
  | "parse_failed"; // page fetched, but the campaign data couldn't be found/validated

export class CampaignConnectorError extends Error {
  constructor(
    public readonly code: CampaignConnectorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CampaignConnectorError";
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CAMPAIGN_PATH = new RegExp(`^/(?:discover|campaigns)/(${UUID.source})(?:/|$)`, "i");

/**
 * Pulls the campaign ID out of a `/discover/{id}` or `/campaigns/{id}` URL.
 * Returns null for Content Rewards URLs of any other shape (the caller can then
 * follow redirects and try again); throws for anything that isn't Content Rewards.
 */
export function parseCampaignIdFromUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new CampaignConnectorError("invalid_url", `Not a URL: ${input}`);
  }
  if (!/^(www\.)?contentrewards\.com$/i.test(url.hostname)) {
    throw new CampaignConnectorError("invalid_url", `Not a Content Rewards URL: ${input}`);
  }
  return url.pathname.match(CAMPAIGN_PATH)?.[1]?.toLowerCase() ?? null;
}

/**
 * Next.js App Router pages stream their data as `self.__next_f.push([1, "<chunk>"])`
 * script tags. Concatenating the string chunks yields the RSC payload text, in which
 * component props (including the campaign object) appear as plain JSON.
 */
export function extractRscPayload(html: string): string {
  const pushes = html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g);
  let payload = "";
  for (const [, arrayLiteral] of pushes) {
    try {
      const chunk: unknown = JSON.parse(arrayLiteral!);
      if (Array.isArray(chunk) && typeof chunk[1] === "string") payload += chunk[1];
    } catch {
      // Non-JSON push (e.g. a binary/form-state chunk); not where campaign data lives.
    }
  }
  return payload;
}

/**
 * Given `text[start]` is `{` or `[`, returns the index just past its matching close, or -1.
 * String-aware, so braces inside JSON strings don't count.
 */
function matchBracketEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return i + 1;
  }
  return -1;
}

const MAX_OBJECT_START_CANDIDATES = 500;

/**
 * Finds the JSON object in the payload whose own top-level `id` is `campaignId`.
 * The ID also appears nested in unrelated props (e.g. `{"campaignId": ...}` on a
 * join button), so we work outward from each occurrence of `"id":"<campaignId>"`:
 * try each enclosing `{` from nearest to farthest and keep the first that parses
 * with a matching top-level id.
 */
export function findCampaignObject(payload: string, campaignId: string): Record<string, unknown> | null {
  const needle = `"id":"${campaignId}"`;
  for (let at = payload.indexOf(needle); at !== -1; at = payload.indexOf(needle, at + 1)) {
    let tries = 0;
    for (let start = payload.lastIndexOf("{", at); start !== -1 && tries < MAX_OBJECT_START_CANDIDATES; start = payload.lastIndexOf("{", start - 1)) {
      tries++;
      const end = matchBracketEnd(payload, start);
      if (end <= at) continue; // this brace closes before the id; not an enclosing object
      try {
        const obj: unknown = JSON.parse(payload.slice(start, end));
        if (obj && typeof obj === "object" && (obj as { id?: unknown }).id === campaignId) {
          return obj as Record<string, unknown>;
        }
      } catch {
        // Started inside a string or at a non-JSON brace; keep widening.
      }
    }
  }
  return null;
}

const rawCampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  organizationName: z.string().nullish(),
  platforms: z.array(z.string()).default([]),
  status: z.string().nullish(),
  payoutType: z.string().nullish(),
  budgetCents: z.number().nullish(),
  private: z.boolean().nullish(),
  requiresApplication: z.boolean().nullish(),
  payouts: z
    .array(
      z.object({
        platform: z.string(),
        payoutType: z.string().nullish(),
        rateCents: z.number().nullish(),
        minPayoutCents: z.number().nullish(),
        maxPayoutCents: z.number().nullish(),
      }),
    )
    .default([]),
  referenceMaterials: z
    .array(
      z.object({
        type: z.string().nullish(),
        mediaType: z.string().nullish(),
        url: z.string().nullish(),
      }),
    )
    .default([]),
});

export type CampaignPayout = {
  platform: string;
  payoutType: string | null;
  rateCents: number | null;
  minPayoutCents: number | null;
  maxPayoutCents: number | null;
};

export type ReferenceMaterial = { type: string | null; mediaType: string | null; url: string };

export type CampaignMetadata = {
  campaignId: string;
  title: string;
  description: string | null;
  brand: string | null;
  platforms: string[];
  /** Content Rewards' own campaign status (e.g. "active", "paused") — not our `campaigns.status`. */
  sourceStatus: string | null;
  payoutType: string | null;
  payouts: CampaignPayout[];
  budgetCents: number | null;
  isPrivate: boolean;
  requiresApplication: boolean;
  referenceMaterials: ReferenceMaterial[];
  guidelineDocUrl: string | null;
  guidelineDocId: string | null;
  /** Null when the campaign lists no Google Drive folder (footage may be linked from the guideline doc instead). */
  driveFolderUrl: string | null;
  driveFolderId: string | null;
};

const GOOGLE_DOC_ID = /^https:\/\/docs\.google\.com\/document\/d\/([\w-]+)/;
const DRIVE_FOLDER_ID = /^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)/;

export function parseGoogleDocId(url: string): string | null {
  return url.match(GOOGLE_DOC_ID)?.[1] ?? null;
}

export function parseDriveFolderId(url: string): string | null {
  return url.match(DRIVE_FOLDER_ID)?.[1] ?? null;
}

/** Parses a fetched `/discover/{id}` page into campaign metadata, or throws `parse_failed`. */
export function parseCampaignPageHtml(html: string, campaignId: string): CampaignMetadata {
  const payload = extractRscPayload(html);
  if (!payload) {
    throw new CampaignConnectorError("parse_failed", "No Next.js RSC payload found in campaign page");
  }
  const obj = findCampaignObject(payload, campaignId);
  if (!obj) {
    throw new CampaignConnectorError("parse_failed", `Campaign object for ${campaignId} not found in page payload`);
  }
  const parsed = rawCampaignSchema.safeParse(obj);
  if (!parsed.success) {
    throw new CampaignConnectorError(
      "parse_failed",
      `Campaign object has unexpected shape: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`,
    );
  }
  const raw = parsed.data;

  const referenceMaterials: ReferenceMaterial[] = raw.referenceMaterials
    .filter((m): m is typeof m & { url: string } => typeof m.url === "string" && m.url.length > 0)
    .map((m) => ({ type: m.type ?? null, mediaType: m.mediaType ?? null, url: m.url }));

  const guidelineDocUrl = referenceMaterials.find((m) => parseGoogleDocId(m.url))?.url ?? null;
  const driveFolderUrl = referenceMaterials.find((m) => parseDriveFolderId(m.url))?.url ?? null;

  return {
    campaignId: raw.id,
    title: raw.name,
    description: raw.description ?? null,
    brand: raw.organizationName ?? null,
    platforms: raw.platforms,
    sourceStatus: raw.status ?? null,
    payoutType: raw.payoutType ?? null,
    payouts: raw.payouts.map((p) => ({
      platform: p.platform,
      payoutType: p.payoutType ?? null,
      rateCents: p.rateCents ?? null,
      minPayoutCents: p.minPayoutCents ?? null,
      maxPayoutCents: p.maxPayoutCents ?? null,
    })),
    budgetCents: raw.budgetCents ?? null,
    isPrivate: raw.private ?? false,
    requiresApplication: raw.requiresApplication ?? false,
    referenceMaterials,
    guidelineDocUrl,
    guidelineDocId: guidelineDocUrl ? parseGoogleDocId(guidelineDocUrl) : null,
    driveFolderUrl,
    driveFolderId: driveFolderUrl ? parseDriveFolderId(driveFolderUrl) : null,
  };
}

// ---------------------------------------------------------------------------
// Discover listing (`GET /discover`): every listed campaign, with the listing's
// own summary fields (its `description` is filled in more often than the
// individual page's).

const listingItemSchema = z.object({
  id: z.string().regex(UUID),
  title: z.string(),
  description: z.string().nullish(),
  brand: z.string().nullish(),
  category: z.string().nullish(),
  platforms: z.array(z.string()).default([]),
  type: z.string().nullish(),
  payoutSortRaw: z.number().nullish(),
  budgetTotalRaw: z.number().nullish(),
  budgetSpentRaw: z.number().nullish(),
  availableBudgetRaw: z.number().nullish(),
  progressPercentage: z.number().nullish(),
  requiresApplication: z.boolean().nullish(),
  isVerified: z.boolean().nullish(),
  creatorCountRaw: z.number().nullish(),
  submissionCountRaw: z.number().nullish(),
  createdAtMs: z.number().nullish(),
});

export type ListedCampaign = {
  campaignId: string;
  url: string;
  title: string;
  description: string | null;
  brand: string | null;
  category: string | null;
  platforms: string[];
  payoutType: string | null;
  /** Headline rate per 1K views, in dollars (the listing's sort key). */
  ratePer1k: number | null;
  budgetTotal: number | null;
  budgetSpent: number | null;
  budgetAvailable: number | null;
  progressPercentage: number | null;
  requiresApplication: boolean;
  isVerified: boolean;
  creatorCount: number | null;
  submissionCount: number | null;
  createdAt: string | null;
};

/** Parses the discover listing page into campaigns, or throws `parse_failed`. */
export function parseDiscoverListingHtml(html: string): ListedCampaign[] {
  const payload = extractRscPayload(html);
  const key = payload.indexOf('"campaigns":[');
  if (key === -1) {
    throw new CampaignConnectorError("parse_failed", "No campaigns array found in discover listing payload");
  }
  const start = key + '"campaigns":'.length;
  const end = matchBracketEnd(payload, start);
  let items: unknown;
  try {
    items = JSON.parse(payload.slice(start, end));
  } catch {
    throw new CampaignConnectorError("parse_failed", "Discover listing campaigns array is not valid JSON");
  }
  const parsed = z.array(listingItemSchema).safeParse(items);
  if (!parsed.success) {
    throw new CampaignConnectorError(
      "parse_failed",
      `Listing campaign has unexpected shape: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => i.path.join(".") + " " + i.message)
        .join("; ")}`,
    );
  }
  if (parsed.data.length === 0) {
    throw new CampaignConnectorError("parse_failed", "Discover listing returned zero campaigns");
  }
  return parsed.data.map((c) => ({
    campaignId: c.id.toLowerCase(),
    url: `https://contentrewards.com/discover/${c.id.toLowerCase()}`,
    title: c.title,
    description: c.description ?? null,
    brand: c.brand ?? null,
    category: c.category || null,
    platforms: c.platforms,
    payoutType: c.type ?? null,
    ratePer1k: c.payoutSortRaw ?? null,
    budgetTotal: c.budgetTotalRaw ?? null,
    budgetSpent: c.budgetSpentRaw ?? null,
    budgetAvailable: c.availableBudgetRaw ?? null,
    progressPercentage: c.progressPercentage ?? null,
    requiresApplication: c.requiresApplication ?? false,
    isVerified: c.isVerified ?? false,
    creatorCount: c.creatorCountRaw ?? null,
    submissionCount: c.submissionCountRaw ?? null,
    createdAt: c.createdAtMs ? new Date(c.createdAtMs).toISOString() : null,
  }));
}
