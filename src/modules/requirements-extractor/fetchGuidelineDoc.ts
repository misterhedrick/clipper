const USER_AGENT = "Mozilla/5.0 (compatible; ClipperBot/0.1; +internal campaign ingestion)";

export class GuidelineDocNotPublicError extends Error {}

function docIdFromUrl(url: string): string {
  const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error(`Could not extract a Google Docs id from "${url}"`);
  return match[1];
}

/**
 * Fetches a Google Doc's plain text via its export endpoint — NOT the
 * `/edit` URL, which shows a sign-in prompt even for a publicly-viewable
 * doc. `/export?format=txt` bypasses that UI and returns the raw text
 * directly for any doc actually shared "anyone with the link can view" —
 * verified against two real campaign docs during implementation (see
 * docs/API_CONTRACTS.md). Throws GuidelineDocNotPublicError if the doc
 * genuinely requires authentication.
 */
export async function fetchGuidelineDocText(guidelineDocUrl: string): Promise<string> {
  const docId = docIdFromUrl(guidelineDocUrl);
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;

  const res = await fetch(exportUrl, { headers: { "User-Agent": USER_AGENT } });
  const contentType = res.headers.get("content-type") ?? "";

  if (!res.ok || !contentType.includes("text/plain")) {
    throw new GuidelineDocNotPublicError(
      `Guideline doc ${guidelineDocUrl} did not return public plain text (status ${res.status}, content-type ${contentType})`,
    );
  }

  return res.text();
}

export type FootageSourceType = "google_drive" | "mediasilo" | "unknown";

export interface DetectedFootageSource {
  url: string;
  sourceType: FootageSourceType;
}

/**
 * Scans guideline doc text for a footage source link. Real campaigns put
 * this inside the doc body (e.g. a "Content Folder:" line), not necessarily
 * on the discover page — see docs/API_CONTRACTS.md § "footage isn't always
 * on Google Drive". Returns null if nothing recognizable is found; that's a
 * legitimate outcome the caller should route to needs_attention, not retry.
 */
export function detectFootageSourceInDocText(text: string): DetectedFootageSource | null {
  const driveMatch = text.match(/https:\/\/drive\.google\.com\/drive\/folders\/[^\s"]+/);
  if (driveMatch) return { url: driveMatch[0], sourceType: "google_drive" };

  const mediaSiloMatch = text.match(/https:\/\/app\.mediasilo\.com\/[^\s"]+/);
  if (mediaSiloMatch) return { url: mediaSiloMatch[0], sourceType: "mediasilo" };

  // Fallback: a "Content Folder: <url>" line pointing somewhere unrecognized.
  const contentFolderMatch = text.match(/Content Folder:\s*(https:\/\/\S+)/i);
  if (contentFolderMatch) return { url: contentFolderMatch[1], sourceType: "unknown" };

  return null;
}
