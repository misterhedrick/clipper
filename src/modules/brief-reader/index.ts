// Reads a public Google Doc (a campaign brief or a sub-doc it links to) as plain
// text plus every hyperlink. Uses the HTML export, not the text export: the text
// export drops hyperlinks, and briefs often link footage from link text
// ("Content Folder: HERE"). Anonymous only. A doc that wants sign-in is reported
// as not_public, never worked around.

export type BriefReaderErrorCode = "not_a_google_doc" | "not_public" | "not_found" | "fetch_failed";

export class BriefReaderError extends Error {
  constructor(
    public readonly code: BriefReaderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BriefReaderError";
  }
}

export type DocLink = { text: string; url: string };

export type GoogleDoc = {
  docId: string;
  url: string;
  /** Readable text. Each hyperlink is rendered inline as `text <url>`, so it's clear which words link where. */
  text: string;
  /** Every distinct http(s) link, in document order, with Google's redirect wrapper removed. */
  links: DocLink[];
};

export type ReaderDeps = { fetch?: typeof fetch };

const REQUEST_TIMEOUT_MS = 20_000;

export function parseGoogleDocUrl(url: string): string | null {
  const m = url.trim().match(/^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([\w-]+)/);
  // `/document/d/e/<id>/pub` is a "publish to web" link, a different ID space.
  if (!m || m[1] === "e") return null;
  return m[1]!;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", bull: "\u2022", middot: "\u00b7",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", euro: "\u20ac", pound: "\u00a3", deg: "\u00b0", times: "\u00d7",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

/** Google Docs wraps outbound links as https://www.google.com/url?q=<real>&sa=…; return the real URL. */
export function unwrapGoogleRedirect(href: string): string {
  try {
    const u = new URL(href);
    if (/^(www\.)?google\.com$/.test(u.hostname) && u.pathname === "/url") {
      return u.searchParams.get("q") ?? href;
    }
  } catch {
    // not an absolute URL; fall through
  }
  return href;
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "");

/** Converts Google Docs' HTML export to readable text and its link list. */
export function parseGoogleDocHtml(html: string): { text: string; links: DocLink[] } {
  const bodyStart = html.search(/<body[\s>]/i);
  let body = bodyStart === -1 ? html : html.slice(bodyStart);
  body = body
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<img[^>]*>/gi, "");

  const links: DocLink[] = [];
  const seen = new Set<string>();
  // Inline renderings go in as placeholders: `<url>` would otherwise be eaten as a tag below.
  const inline: string[] = [];
  body = body.replace(/<a\s[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, rawHref: string, inner: string) => {
    const text = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    const url = unwrapGoogleRedirect(decodeEntities(rawHref));
    if (!/^https?:\/\//i.test(url)) return text; // in-doc anchors (#heading), mailto:, etc.
    if (!seen.has(url)) {
      seen.add(url);
      links.push({ text, url });
    }
    // Keep link text readable and show where it points, unless the text *is* the URL.
    inline.push(text && text !== url ? `${text} <${url}>` : `<${url}>`);
    return `\u0000${inline.length - 1}\u0000`;
  });

  const text = decodeEntities(
    stripTags(
      body
        // A table cell's paragraphs stay on the cell's line.
        .replace(/<t([dh])([^>]*)>([\s\S]*?)<\/t\1>/gi, (_m, k: string, attrs: string, inner: string) =>
          `<t${k}${attrs}>${inner.replace(/<\/p>|<br\s*\/?>/gi, " ")}</t${k}>`,
        )
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<li[^>]*>/gi, "\n- ")
        .replace(/<\/li>/gi, "") // the next <li> (or the list's end) starts the new line
        .replace(/<\/(p|h[1-6]|tr|div|ul|ol|table)>/gi, "\n")
        .replace(/<\/t[dh]>/gi, " | "),
    ),
  )
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => inline[Number(i)]!);

  return { text, links };
}

/** Fetches and parses a public Google Doc. */
export async function readGoogleDoc(url: string, deps: ReaderDeps = {}): Promise<GoogleDoc> {
  const docId = parseGoogleDocUrl(url);
  if (!docId) throw new BriefReaderError("not_a_google_doc", `Not a Google Docs document URL: ${url}`);

  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=html`;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(exportUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new BriefReaderError("fetch_failed", `Request for doc ${docId} failed: ${(err as Error).message}`);
  }

  const landedOnSignIn = /(^|\.)accounts\.google\.com$/.test(safeHost(res.url));
  if (res.status === 401 || res.status === 403 || landedOnSignIn) {
    throw new BriefReaderError("not_public", `Doc ${docId} isn't publicly readable (sign-in required)`);
  }
  if (res.status === 404) throw new BriefReaderError("not_found", `Doc ${docId} doesn't exist or was deleted`);
  if (!res.ok) throw new BriefReaderError("fetch_failed", `Export of doc ${docId} returned HTTP ${res.status}`);

  const { text, links } = parseGoogleDocHtml(await res.text());
  return { docId, url: url.trim(), text, links };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
