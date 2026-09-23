import type { FootageKind } from "../../db/schema.js";
import { decodeEntities } from "../brief-reader/index.js";
import { classifyFootageUrl } from "./classify.js";

// Expands a footage link into the videos (and other files) behind it, anonymously.
// Listing is mechanical; deciding which entries are footage is the operator's job,
// so non-video files and folder paths are returned too.

export type FootageErrorCode = "unsupported_host" | "not_accessible" | "fetch_failed" | "parse_failed";

export class FootageError extends Error {
  constructor(
    public readonly code: FootageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FootageError";
  }
}

export type FootageEntry = {
  /** Present for videos OpusClip can take; this is the dedupe key `footage select` records. */
  sourceKey: string | null;
  kind: FootageKind;
  name: string;
  /** The URL to hand to `footage select` (and, for videos, to OpusClip). */
  url: string;
  /** Folder path inside the listed source, e.g. "Raw to edit/Day 1". Empty at the top level. */
  path: string;
  isVideo: boolean;
  mimeType?: string | null;
  modified?: string | null;
  isShort?: boolean;
  publishedAt?: string | null;
  description?: string | null;
  views?: number | null;
};

export type Listing = {
  url: string;
  kind: FootageKind | null;
  role: "folder" | "channel" | "file" | "unsupported";
  listable: boolean;
  entries: FootageEntry[];
  folders: { path: string; url: string }[];
  note?: string;
};

export type ListDeps = { fetch?: typeof fetch };
export type ListOptions = { maxDepth?: number; maxFolders?: number };

const UA = "Mozilla/5.0 (compatible; clipper/0.1)";
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|avi|webm|wmv|mts|m2ts)$/i;

async function get(deps: ListDeps, url: string): Promise<Response> {
  try {
    return await (deps.fetch ?? fetch)(url, {
      headers: { "user-agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new FootageError("fetch_failed", `Request to ${url} failed: ${(err as Error).message}`);
  }
}

export async function listFootageUrl(url: string, deps: ListDeps = {}, opts: ListOptions = {}): Promise<Listing> {
  const c = classifyFootageUrl(url);
  if (c.role === "unsupported") throw new FootageError("unsupported_host", `${c.url}: ${c.reason}`);
  if (c.role === "file") {
    const name = decodeURIComponent(new URL(c.videoUrl).pathname.split("/").filter(Boolean).pop() ?? c.videoUrl);
    return {
      url: c.url,
      kind: c.kind,
      role: "file",
      listable: true,
      folders: [],
      entries: [{ sourceKey: c.sourceKey, kind: c.kind, name, url: c.videoUrl, path: "", isVideo: true }],
    };
  }
  if (c.kind === "gdrive_folder") return listDriveFolder(c.id!, c.url, deps, opts);
  if (c.kind === "youtube_channel") return listYouTubeChannel(c.url, c.id, deps);
  return {
    url: c.url,
    kind: c.kind,
    role: c.role,
    listable: false,
    entries: [],
    folders: [],
    note: "Dropbox folders can't be listed yet. Ask a person for direct file links (dropbox.com/scl/fi/…) or skip.",
  };
}

// --- Google Drive ------------------------------------------------------------

type DriveItem = { id: string; name: string; href: string; isFolder: boolean; mimeType: string | null; modified: string | null };

/** Parses Drive's public `embeddedfolderview` page (no API key needed for link-shared folders). */
export function parseDriveFolderHtml(html: string): DriveItem[] {
  const items: DriveItem[] = [];
  const re = /<div class="flip-entry" id="entry-([\w-]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-list-icon">([\s\S]*?)<\/div>\s*<div class="flip-entry-title">([^<]*)<\/div>[\s\S]*?<div class="flip-entry-last-modified"><div>([^<]*)<\/div>/g;
  for (const m of html.matchAll(re)) {
    const [, id, href, icon, title, modified] = m as unknown as string[];
    const isFolder = /\/drive\/(?:u\/\d+\/)?folders\//.test(href!) || /aria-label="Folder"/.test(icon!);
    const mimeType = icon!.match(/\/type\/([\w.+-]+\/[\w.+-]+)/)?.[1] ?? null;
    items.push({ id: id!, name: decodeEntities(title!), href: decodeEntities(href!), isFolder, mimeType, modified: modified || null });
  }
  return items;
}

async function listDriveFolder(rootId: string, rootUrl: string, deps: ListDeps, opts: ListOptions): Promise<Listing> {
  const maxDepth = opts.maxDepth ?? 3;
  const maxFolders = opts.maxFolders ?? 40;
  const entries: FootageEntry[] = [];
  const folders: { path: string; url: string }[] = [];
  const queue: { id: string; path: string; depth: number }[] = [{ id: rootId, path: "", depth: 0 }];
  let fetched = 0;
  let truncated = false;

  while (queue.length) {
    const { id, path, depth } = queue.shift()!;
    if (fetched >= maxFolders) {
      truncated = true;
      break;
    }
    const res = await get(deps, `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`);
    fetched++;
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      if (depth === 0) throw new FootageError("not_accessible", `Drive folder ${id} doesn't exist or isn't shared publicly`);
      continue; // a private subfolder: skip it, keep the rest
    }
    if (!res.ok) throw new FootageError("fetch_failed", `Drive folder ${id} returned HTTP ${res.status}`);
    const html = await res.text();
    if (depth === 0 && !html.includes("flip-entries") && !html.includes("flip-entry")) {
      throw new FootageError("parse_failed", `Drive folder ${id}: unexpected page (no folder listing found)`);
    }
    for (const item of parseDriveFolderHtml(html)) {
      const itemPath = path ? `${path}/${item.name}` : item.name;
      if (item.isFolder) {
        folders.push({ path: itemPath, url: `https://drive.google.com/drive/folders/${item.id}` });
        if (depth + 1 <= maxDepth) queue.push({ id: item.id, path: itemPath, depth: depth + 1 });
        else truncated = true;
        continue;
      }
      const isVideo = (item.mimeType?.startsWith("video/") ?? false) || VIDEO_EXT.test(item.name);
      entries.push({
        sourceKey: isVideo ? `gdrive:${item.id}` : null,
        kind: "gdrive_file",
        name: item.name,
        url: `https://drive.google.com/file/d/${item.id}/view`,
        path,
        isVideo,
        mimeType: item.mimeType,
        modified: item.modified,
      });
    }
  }
  return {
    url: rootUrl,
    kind: "gdrive_folder",
    role: "folder",
    listable: true,
    entries,
    folders,
    ...(truncated ? { note: `Listing stopped at depth ${maxDepth} / ${maxFolders} folders; some subfolders weren't expanded.` } : {}),
  };
}

// --- YouTube -------------------------------------------------------------------

export function parseYouTubeFeed(xml: string): FootageEntry[] {
  const entries: FootageEntry[] = [];
  for (const [, body] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const pick = (re: RegExp) => body!.match(re)?.[1] ?? null;
    const videoId = pick(/<yt:videoId>([\w-]{11})<\/yt:videoId>/);
    if (!videoId) continue;
    const link = pick(/<link rel="alternate" href="([^"]+)"/) ?? "";
    const views = pick(/<media:statistics views="(\d+)"/);
    entries.push({
      sourceKey: `youtube:${videoId}`,
      kind: "youtube_video",
      name: decodeEntities(pick(/<title>([\s\S]*?)<\/title>/) ?? videoId),
      url: `https://www.youtube.com/watch?v=${videoId}`,
      path: "",
      isVideo: true,
      isShort: link.includes("/shorts/"),
      publishedAt: pick(/<published>([^<]+)<\/published>/),
      description: decodeEntities(pick(/<media:description>([\s\S]*?)<\/media:description>/) ?? "") || null,
      views: views ? Number(views) : null,
    });
  }
  return entries;
}

async function listYouTubeChannel(url: string, knownId: string | null, deps: ListDeps): Promise<Listing> {
  let channelId = knownId;
  if (!channelId) {
    const res = await get(deps, url);
    if (res.status === 404) throw new FootageError("not_accessible", `YouTube channel not found: ${url}`);
    if (!res.ok) throw new FootageError("fetch_failed", `${url} returned HTTP ${res.status}`);
    // The canonical link names the page's own channel; other "channelId"s on the page are featured channels.
    channelId = (await res.text()).match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] ?? null;
    if (!channelId) throw new FootageError("parse_failed", `Couldn't find the channel ID on ${url}`);
  }
  const res = await get(deps, `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!res.ok) throw new FootageError("fetch_failed", `YouTube feed for ${channelId} returned HTTP ${res.status}`);
  const entries = parseYouTubeFeed(await res.text());
  return {
    url,
    kind: "youtube_channel",
    role: "channel",
    listable: true,
    entries,
    folders: [],
    note: `Only the channel's ${entries.length} most recent uploads (YouTube's feed limit). Shorts are marked isShort; they're usually finished clips, not source footage.`,
  };
}
