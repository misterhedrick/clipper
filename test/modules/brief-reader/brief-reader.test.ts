import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BriefReaderError,
  decodeEntities,
  parseGoogleDocHtml,
  parseGoogleDocUrl,
  readGoogleDoc,
  unwrapGoogleRedirect,
} from "../../../src/modules/brief-reader/index.js";

// Synthetic doc in Google Docs' HTML export markup: redirect-wrapped links, link text
// that is/isn't the URL, an in-doc anchor, lists, a table, entities, an inline image.
const html = readFileSync(new URL("../../fixtures/google-doc-export.html", import.meta.url), "utf8");

describe("parseGoogleDocHtml", () => {
  const { text, links } = parseGoogleDocHtml(html);

  it("keeps every link inline in the text, next to the words that link it", () => {
    // Regression: `<url>` renderings used to be eaten by tag stripping.
    expect(text).toContain("Content Folder: <https://drive.google.com/drive/folders/FOLDER123?usp=sharing>");
    expect(text).toContain("Brand assets: VIDEO OVERLAY <https://drive.google.com/drive/folders/ASSETS456> (use on every clip)");
    expect(text).toContain("Caption rules: see Caption Guide <https://docs.google.com/document/d/SUBDOC789/edit>.");
  });

  it("lists distinct http(s) links in order, unwrapped from Google's redirect", () => {
    expect(links).toEqual([
      {
        text: "https://drive.google.com/drive/folders/FOLDER123?usp=sharing",
        url: "https://drive.google.com/drive/folders/FOLDER123?usp=sharing",
      },
      { text: "VIDEO OVERLAY", url: "https://drive.google.com/drive/folders/ASSETS456" },
      { text: "Caption Guide", url: "https://docs.google.com/document/d/SUBDOC789/edit" },
    ]);
  });

  it("renders in-doc anchors as plain text and drops styles and images", () => {
    expect(text).toContain("Jump to Payment terms.");
    expect(text).not.toMatch(/#h\.abc123|base64|list-style|lst-kix/);
  });

  it("produces readable structure: headings, one line per bullet, table cells, decoded entities", () => {
    expect(text).toMatch(/^Example Campaign – Clipping Brief\n/);
    expect(text).toContain("What to Clip\n\n- Business & entrepreneurship\n- “High-performance” conversations");
    expect(text).toContain("Platform | CPM |");
    expect(text).toContain("Must include #Ad & tag @brand — no exceptions ✓");
    expect(text).not.toMatch(/&[a-z]+;|\n{3,}/);
  });
});

describe("helpers", () => {
  it("parses Google Doc URLs, refusing publish-to-web links", () => {
    expect(parseGoogleDocUrl("https://docs.google.com/document/d/1AbC_d-9/edit?usp=sharing")).toBe("1AbC_d-9");
    expect(parseGoogleDocUrl("https://docs.google.com/document/u/1/d/XYZ/view")).toBe("XYZ");
    expect(parseGoogleDocUrl("https://docs.google.com/document/d/e/2PACX-abc/pub")).toBeNull();
    expect(parseGoogleDocUrl("https://drive.google.com/drive/folders/abc")).toBeNull();
  });

  it("unwraps only Google's /url redirect", () => {
    expect(unwrapGoogleRedirect("https://www.google.com/url?q=https://x.com/a?b%3Dc&sa=D")).toBe("https://x.com/a?b=c");
    expect(unwrapGoogleRedirect("https://example.com/url?q=https://x.com")).toBe("https://example.com/url?q=https://x.com");
  });

  it("decodes numeric and named entities, leaving unknown ones alone", () => {
    expect(decodeEntities("&#8212;&#x2713;&amp;&rsquo;&bogus;")).toBe("—✓&’&bogus;");
  });
});

describe("readGoogleDoc", () => {
  const respond = (status: number, body = "", finalUrl?: string) =>
    vi.fn(async (input: string | URL | Request) => {
      const res = new Response(body, { status });
      Object.defineProperty(res, "url", { value: finalUrl ?? String(input) });
      return res;
    }) as unknown as typeof fetch;
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(BriefReaderError);
      return (e as BriefReaderError).code;
    }
    return "resolved";
  };
  const DOC = "https://docs.google.com/document/d/DOC1/edit";

  it("fetches the HTML export and parses it", async () => {
    const fetch = respond(200, html);
    const doc = await readGoogleDoc(DOC, { fetch });
    expect(fetch).toHaveBeenCalledWith("https://docs.google.com/document/d/DOC1/export?format=html", expect.anything());
    expect(doc.docId).toBe("DOC1");
    expect(doc.links).toHaveLength(3);
  });

  it("reports sign-in walls as not_public, never as a retryable error", async () => {
    expect(await code(readGoogleDoc(DOC, { fetch: respond(401) }))).toBe("not_public");
    expect(await code(readGoogleDoc(DOC, { fetch: respond(403) }))).toBe("not_public");
    expect(
      await code(readGoogleDoc(DOC, { fetch: respond(200, "<html>Sign in</html>", "https://accounts.google.com/ServiceLogin?x") })),
    ).toBe("not_public");
  });

  it("maps other failures", async () => {
    expect(await code(readGoogleDoc(DOC, { fetch: respond(404) }))).toBe("not_found");
    expect(await code(readGoogleDoc(DOC, { fetch: respond(500) }))).toBe("fetch_failed");
    const broken = vi.fn(async () => {
      throw new TypeError("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await code(readGoogleDoc(DOC, { fetch: broken }))).toBe("fetch_failed");
    expect(await code(readGoogleDoc("https://drive.google.com/drive/folders/x", { fetch: broken }))).toBe("not_a_google_doc");
  });
});
