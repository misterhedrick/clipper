// Reads a public Notion page (a campaign's rules page) as plain text plus every
// hyperlink, in the same shape as a Google Doc. Notion renders pages in the
// browser, so the page HTML holds no content; the text comes from the endpoint
// Notion's own public viewer calls (`loadPageChunk`), which serves pages that
// are shared to the web without sign-in. Anonymous only: a page that isn't
// public comes back empty and is reported as not_public, never worked around.

import { z } from "zod";
import { BriefReaderError, type DocLink, type ReaderDeps } from "./types.js";

export type NotionPage = {
  pageId: string;
  url: string;
  title: string;
  /** Readable text. Each hyperlink is rendered inline as `text <url>`, as for Google Docs. */
  text: string;
  /** Every distinct http(s) link, in page order. Child pages and page mentions are included as notion.so links. */
  links: DocLink[];
};

const API_BASE = "https://www.notion.so/api/v3";
const REQUEST_TIMEOUT_MS = 20_000;
// Notion sits behind Cloudflare, which answers a request with no user agent (Node's fetch default) with a 403 page.
const USER_AGENT = "Mozilla/5.0 (compatible; clipper/0.1; +https://github.com/misterhedrick/clipper)";
const CHUNK_LIMIT = 100;
/** A rules page is a few hundred blocks at most; stop paging well past that. */
const MAX_CHUNKS = 20;
/** Blocks fetched by ID per syncRecordValues call, and in all. */
const SYNC_BATCH = 100;
const MAX_BLOCKS = 2_000;

/**
 * The page ID (dashed UUID) from a Notion page URL: notion.so, notion.site
 * (public sites) and app.notion.com links, with the ID as the last 32 hex
 * characters of the path, dashed or not.
 */
export function parseNotionPageUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !/(^|\.)notion\.(so|site|com)$/.test(u.hostname)) return null;
  const m = u.pathname.replace(/-/g, "").match(/([0-9a-f]{32})$/i);
  if (!m) return null;
  const hex = m[1]!.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const notionPageLink = (id: string) => `https://www.notion.so/${id.replace(/-/g, "")}`;

// --- API response -------------------------------------------------------------

const Block = z
  .object({
    id: z.string(),
    type: z.string(),
    properties: z.record(z.string(), z.unknown()).optional(),
    content: z.array(z.string()).optional(),
    format: z.record(z.string(), z.unknown()).optional(),
    alive: z.boolean().optional(),
  })
  .passthrough();
type Block = z.infer<typeof Block>;

// Records come as `{ value: <block> }` or, in newer responses, `{ value: { value: <block>, role } }`.
const BlockRecord = z.object({ value: z.unknown() }).passthrough();

const ChunkResponse = z.object({
  cursor: z.object({ stack: z.array(z.unknown()) }).passthrough().optional(),
  recordMap: z.object({ block: z.record(z.string(), BlockRecord).optional() }).passthrough(),
});

function unwrapBlock(record: z.infer<typeof BlockRecord>): Block | null {
  const v = record.value as { value?: unknown } | undefined;
  const inner = v && typeof v === "object" && "value" in v && v.value && typeof v.value === "object" ? v.value : v;
  const parsed = Block.safeParse(inner);
  // Deleted blocks are kept (so they aren't mistaken for unloaded ones) and skipped when rendering.
  return parsed.success ? parsed.data : null;
}

// --- rendering ----------------------------------------------------------------

type RichText = unknown[];

class Renderer {
  readonly links: DocLink[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly blocks: Map<string, Block>,
    private readonly rootId: string,
  ) {}

  private addLink(text: string, url: string) {
    if (!this.seen.has(url)) {
      this.seen.add(url);
      this.links.push({ text, url });
    }
  }

  /** Notion rich text: `[[text, [[annotation, arg?], ...]?], ...]`. */
  richText(value: unknown): string {
    if (!Array.isArray(value)) return "";
    return (value as RichText)
      .map((seg) => {
        if (!Array.isArray(seg)) return "";
        const text = typeof seg[0] === "string" ? seg[0] : "";
        const annotations = Array.isArray(seg[1]) ? (seg[1] as unknown[][]) : [];
        const link = annotations.find((a) => Array.isArray(a) && a[0] === "a" && typeof a[1] === "string");
        if (link) {
          const url = link[1] as string;
          if (!/^https?:\/\//i.test(url)) return text;
          this.addLink(text, url);
          return text && text !== url ? `${text} <${url}>` : `<${url}>`;
        }
        if (text === "‣") return this.mention(annotations);
        return text;
      })
      .join("");
  }

  /** `‣` stands for an inline mention; the annotation says of what. */
  private mention(annotations: unknown[][]): string {
    for (const a of annotations) {
      if (!Array.isArray(a)) continue;
      if (a[0] === "p" && typeof a[1] === "string") {
        const title = this.titleOf(a[1]) || "Notion page";
        const url = notionPageLink(a[1]);
        this.addLink(title, url);
        return `${title} <${url}>`;
      }
      if (a[0] === "d" && a[1] && typeof a[1] === "object") {
        const d = a[1] as { start_date?: string; end_date?: string };
        return [d.start_date, d.end_date].filter(Boolean).join(" to ");
      }
      if (a[0] === "u") return "@user";
      // Link previews (Dropbox, Drive, ...) live in records the public endpoint doesn't serve.
      if (a[0] === "eoi" || a[0] === "lm") return "[link preview: open the page to see it]";
    }
    return "";
  }

  private titleOf(id: string): string {
    const b = this.blocks.get(id);
    return b ? this.richText(b.properties?.title).trim() : "";
  }

  render(id: string, depth = 0, out: string[] = []): string[] {
    const b = this.blocks.get(id);
    if (!b || b.alive === false) return out;
    const indent = "  ".repeat(depth);
    const title = this.richText(b.properties?.title).replace(/\s*\n\s*/g, " ").trim();
    const children = (nextDepth: number) => {
      for (const c of b.content ?? []) this.render(c, nextDepth, out);
    };

    switch (b.type) {
      case "bulleted_list":
      case "numbered_list":
        out.push(`${indent}- ${title}`);
        children(depth + 1);
        return out;
      case "to_do": {
        const checked = JSON.stringify(b.properties?.checked ?? "").includes("Yes");
        out.push(`${indent}- [${checked ? "x" : " "}] ${title}`);
        children(depth + 1);
        return out;
      }
      case "divider":
        out.push("");
        return out;
      case "callout": {
        const icon = typeof b.format?.page_icon === "string" ? `${b.format.page_icon} ` : "";
        if (title) out.push(`${indent}${icon}${title}`);
        else if (icon) out.push(`${indent}${icon.trim()}`);
        children(depth);
        return out;
      }
      case "table": {
        const order = Array.isArray(b.format?.table_block_column_order)
          ? (b.format.table_block_column_order as string[])
          : null;
        for (const rowId of b.content ?? []) {
          const row = this.blocks.get(rowId);
          if (!row) continue;
          const cols = order ?? Object.keys(row.properties ?? {});
          out.push(indent + cols.map((c) => this.richText(row.properties?.[c]).trim()).join(" | "));
        }
        return out;
      }
      case "page":
      case "collection_view_page":
        // A child page: show where it is so it can be read next (its content isn't loaded here).
        if (b.id !== this.rootId) {
          const url = notionPageLink(b.id);
          this.addLink(title || "Notion page", url);
          out.push(`${indent}${title || "Notion page"} <${url}>`);
          return out;
        }
        children(depth);
        return out;
      case "collection_view":
        out.push(`${indent}[database: open the page to see it]`);
        return out;
      case "image":
      case "video":
      case "file":
      case "pdf":
      case "audio":
      case "bookmark":
      case "embed": {
        const source = this.richText(b.properties?.source).trim() || String(b.format?.display_source ?? "");
        if (/^https?:\/\//i.test(source)) {
          const label = b.type === "bookmark" ? title || source : `${b.type}${title ? `: ${title}` : ""}`;
          this.addLink(label, source);
          out.push(`${indent}${label} <${source}>`);
        } else if (b.type !== "image") {
          out.push(`${indent}[${b.type}${title ? `: ${title}` : ""}]`);
        }
        return out;
      }
      default:
        // text, headers, quote, toggle, column_list, column, and anything new: its text, then its children.
        if (title) out.push(`${indent}${title}`);
        children(b.type === "toggle" || b.type === "quote" ? depth + 1 : depth);
        return out;
    }
  }
}

/** Renders a loaded page's blocks (keyed by ID) to text and its link list. */
export function renderNotionPage(pageId: string, blocks: Map<string, Block>): { title: string; text: string; links: DocLink[] } {
  const r = new Renderer(blocks, pageId);
  const page = blocks.get(pageId);
  const title = page ? r.richText(page.properties?.title).trim() : "";
  const lines = r.render(pageId);
  const text = [title, "", ...lines]
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text, links: r.links };
}

/** Collects every block from `loadPageChunk` / `syncRecordValues` records (either nesting). */
export function collectNotionBlocks(recordMaps: unknown[]): Map<string, Block> {
  const blocks = new Map<string, Block>();
  for (const rm of recordMaps) {
    const parsed = ChunkResponse.shape.recordMap.safeParse(rm);
    if (!parsed.success) continue;
    for (const record of Object.values(parsed.data.block ?? {})) {
      const b = unwrapBlock(record);
      if (b) blocks.set(b.id, b);
    }
  }
  return blocks;
}

/** Block IDs the page's rendering would visit but that aren't loaded yet (child pages' own content excluded). */
export function missingNotionBlocks(rootId: string, blocks: Map<string, Block>): string[] {
  const missing = new Set<string>();
  const visit = (id: string) => {
    const b = blocks.get(id);
    if (!b) {
      missing.add(id);
      return;
    }
    if (b.alive === false) return;
    if (id !== rootId && (b.type === "page" || b.type === "collection_view_page" || b.type === "collection_view")) return;
    for (const c of b.content ?? []) visit(c);
  };
  visit(rootId);
  return [...missing];
}

/** The page's workspace ID, which syncRecordValues needs: on the record (newer shape) or the block (older). */
function spaceIdOf(recordMaps: unknown[], pageId: string): string | null {
  for (const rm of recordMaps) {
    const record = (rm as { block?: Record<string, { spaceId?: unknown; value?: { space_id?: unknown; value?: { space_id?: unknown } } }> })
      ?.block?.[pageId];
    const id = record?.spaceId ?? record?.value?.value?.space_id ?? record?.value?.space_id;
    if (typeof id === "string") return id;
  }
  return null;
}

async function post(path: string, body: unknown, pageId: string, deps: ReaderDeps): Promise<unknown> {
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${API_BASE}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new BriefReaderError("fetch_failed", `Request for Notion page ${pageId} failed: ${(err as Error).message}`);
  }
  // Private pages don't error (they come back empty); an HTTP error here is Notion or Cloudflare refusing the request.
  if (!res.ok) throw new BriefReaderError("fetch_failed", `Notion page ${pageId}: ${path} returned HTTP ${res.status}`);
  return res.json().catch(() => null);
}

/**
 * Fetches and parses a public Notion page. `loadPageChunk` returns the page's
 * top-level blocks but not what's inside collapsed toggles and toggle headings,
 * where rules pages keep most of their text; those are fetched by ID with
 * `syncRecordValues` until nothing the page shows is missing.
 */
export async function readNotionPage(url: string, deps: ReaderDeps = {}): Promise<NotionPage> {
  const pageId = parseNotionPageUrl(url);
  if (!pageId) throw new BriefReaderError("unsupported_doc", `Not a Notion page URL: ${url}`);

  const recordMaps: unknown[] = [];
  let cursor: { stack: unknown[] } = { stack: [] };
  for (let chunkNumber = 0; chunkNumber < MAX_CHUNKS; chunkNumber++) {
    const body = ChunkResponse.safeParse(
      await post("loadPageChunk", { pageId, limit: CHUNK_LIMIT, cursor, chunkNumber, verticalColumns: false }, pageId, deps),
    );
    if (!body.success) throw new BriefReaderError("fetch_failed", `Notion page ${pageId}: unexpected response shape`);
    recordMaps.push(body.data.recordMap);
    const next = body.data.cursor?.stack ?? [];
    if (next.length === 0) break;
    cursor = { stack: next };
  }

  let blocks = collectNotionBlocks(recordMaps);
  if (!blocks.has(pageId)) {
    // Notion answers a private or deleted page with an empty record map; the two can't be told apart.
    throw new BriefReaderError("not_public", `Notion page ${pageId} isn't public or doesn't exist (no content without sign-in)`);
  }

  const spaceId = spaceIdOf(recordMaps, pageId);
  const requested = new Set<string>();
  while (spaceId && requested.size < MAX_BLOCKS) {
    const batch = missingNotionBlocks(pageId, blocks)
      .filter((id) => !requested.has(id))
      .slice(0, Math.min(SYNC_BATCH, MAX_BLOCKS - requested.size));
    if (batch.length === 0) break;
    for (const id of batch) requested.add(id);
    const body = ChunkResponse.pick({ recordMap: true }).safeParse(
      await post(
        "syncRecordValues",
        { requests: batch.map((id) => ({ pointer: { table: "block", id, spaceId }, version: -1 })) },
        pageId,
        deps,
      ),
    );
    if (!body.success) throw new BriefReaderError("fetch_failed", `Notion page ${pageId}: unexpected response shape`);
    recordMaps.push(body.data.recordMap);
    blocks = collectNotionBlocks(recordMaps);
  }

  const { title, text, links } = renderNotionPage(pageId, blocks);
  return { pageId, url: url.trim(), title, text, links };
}
