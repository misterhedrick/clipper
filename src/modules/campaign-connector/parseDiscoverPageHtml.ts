/**
 * Content Rewards' campaign pages are Next.js App Router pages. There is no
 * official API (see docs/API_CONTRACTS.md) — this file is a reverse-engineered
 * parser, isolated here on purpose so a markup change only breaks one file.
 *
 * The most reliable extraction point turned out NOT to be the React Server
 * Component payload (which mixes escaped JSON with React element arrays and
 * repeats keys like "id"/"title" across unrelated nested objects), but the
 * page's own `<script type="application/ld+json">` blocks — schema.org
 * structured data the page embeds for SEO, which is well-formed, self
 * contained JSON by construction. Each page embeds several of these; the
 * campaign's own data is the one with `"@type":"Product"`.
 */

export interface ParsedCampaignFields {
  id: string;
  title: string | null;
  brand: string | null;
  description: string | null;
  platforms: string[];
  payout: {
    cpmMinRateCents: number | null;
    cpmMaxRateCents: number | null;
    budgetCents: number | null;
  };
  guidelineDocUrl: string | null;
  driveFolderUrl: string | null;
}

function unescapeSlashQuotes(html: string): string {
  return html.replace(/\\"/g, '"');
}

interface ProductLdJson {
  "@type": "Product";
  name: string;
  description?: string;
  brand?: { name?: string };
}

function extractProductLdJson(html: string): ProductLdJson | null {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (data["@type"] === "Product") return data as ProductLdJson;
    } catch {
      // not valid JSON, or not the block we want — keep scanning
    }
  }
  return null;
}

function extractNumberField(text: string, key: string): number | null {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
  return match ? Number(match[1]) : null;
}

export function parseCampaignFromDiscoverHtml(html: string, campaignId: string): ParsedCampaignFields | null {
  if (!html.includes(campaignId)) return null;

  const text = unescapeSlashQuotes(html);
  const product = extractProductLdJson(text);

  const platformsMatch = text.match(/"platforms"\s*:\s*(\[[^\]]*\])/);
  const platforms: string[] = platformsMatch ? JSON.parse(platformsMatch[1]) : [];

  const guidelineDocMatch = text.match(/https:\/\/docs\.google\.com\/document\/d\/[^"\\\s]+/);
  const driveFolderMatch = text.match(/https:\/\/drive\.google\.com\/drive\/folders\/[^"\\\s]+/);

  return {
    id: campaignId,
    title: product?.name ?? null,
    brand: product?.brand?.name ?? null,
    description: product?.description ?? null,
    platforms,
    payout: {
      cpmMinRateCents: extractNumberField(text, "cpmMinRateCents"),
      cpmMaxRateCents: extractNumberField(text, "cpmMaxRateCents"),
      budgetCents: extractNumberField(text, "budgetCents"),
    },
    guidelineDocUrl: guidelineDocMatch ? guidelineDocMatch[0] : null,
    // Not every campaign links its footage folder directly on the page —
    // confirmed by inspecting real campaigns during planning (some expose
    // it here, some only inside the guideline doc, some only after joining).
    // A null here is a legitimate outcome, not necessarily a parse failure.
    driveFolderUrl: driveFolderMatch ? driveFolderMatch[0] : null,
  };
}
