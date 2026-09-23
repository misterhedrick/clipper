import { createHash } from "node:crypto";
import type { FootageKind } from "../../db/schema.js";

// Turns any footage link from a brief into what it is: a container to list
// (Drive folder, YouTube channel, Dropbox folder), a single video with a stable
// dedupe key and the URL OpusClip should get, or something OpusClip can't ingest.

export type Classified =
  | { role: "folder" | "channel"; kind: FootageKind; url: string; id: string | null }
  | { role: "file"; kind: FootageKind; url: string; sourceKey: string; videoUrl: string }
  | { role: "unsupported"; kind: null; url: string; reason: string };

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

function unsupported(url: string, reason: string): Classified {
  return { role: "unsupported", kind: null, url, reason };
}

function file(kind: FootageKind, url: string, key: string, videoUrl: string): Classified {
  return { role: "file", kind, url, sourceKey: `${kind === "gdrive_file" ? "gdrive" : kind === "youtube_video" ? "youtube" : kind}:${key}`, videoUrl };
}

export function classifyFootageUrl(input: string): Classified {
  const raw = input.trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return unsupported(raw, "not a URL");
  }
  const host = u.hostname.replace(/^(www|m)\./, "").toLowerCase();
  const path = u.pathname;
  let m: RegExpMatchArray | null;

  if (host === "drive.google.com") {
    if ((m = path.match(/^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)/))) {
      return { role: "folder", kind: "gdrive_folder", url: raw, id: m[1]! };
    }
    const id = path.match(/^\/file\/d\/([\w-]+)/)?.[1] ?? (/^\/(open|uc)$/.test(path) ? u.searchParams.get("id") : null);
    if (id) return file("gdrive_file", raw, id, `https://drive.google.com/file/d/${id}/view`);
    return unsupported(raw, "Google Drive link that isn't a file or folder");
  }

  if (host === "youtube.com" || host === "youtu.be") {
    const videoId =
      host === "youtu.be"
        ? path.slice(1).split("/")[0]
        : path === "/watch"
          ? u.searchParams.get("v")
          : path.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1];
    if (videoId && /^[\w-]{11}$/.test(videoId)) {
      return file("youtube_video", raw, videoId, `https://www.youtube.com/watch?v=${videoId}`);
    }
    if ((m = path.match(/^\/channel\/(UC[\w-]{22})/))) return { role: "channel", kind: "youtube_channel", url: raw, id: m[1]! };
    if (/^\/(@[\w.-]+|c\/[\w.-]+|user\/[\w.-]+)\/?/.test(path)) return { role: "channel", kind: "youtube_channel", url: raw, id: null };
    return unsupported(raw, "YouTube link that isn't a video or channel");
  }

  if (/(^|\.)amazonaws\.com$/.test(host) && /\.(mp4|mov|m4v|mkv)$/i.test(path)) {
    const clean = `${u.origin}${path}`;
    return file("s3_mp4", raw, hash(clean), clean);
  }

  if (host === "dropbox.com") {
    if (path.startsWith("/home")) return unsupported(raw, "private Dropbox path (only the owner can open it)");
    const params = new URLSearchParams(u.search);
    params.delete("dl");
    const clean = `${u.origin}${path}${params.size ? `?${params}` : ""}`;
    if (/^\/(scl\/fo|sh)\//.test(path)) return { role: "folder", kind: "dropbox", url: clean, id: null };
    if (/^\/(scl\/fi|s)\//.test(path)) return file("dropbox", raw, hash(clean), clean);
    return unsupported(raw, "Dropbox link that isn't a shared file or folder");
  }

  if (host === "frame.io" || host.endsWith(".frame.io") || host === "f.io") {
    const clean = `${u.origin}${path}`;
    return file("frameio", raw, hash(clean), clean);
  }
  if (host === "loom.com" && (m = path.match(/^\/share\/([\w-]+)/))) {
    return file("loom", raw, m[1]!, `https://www.loom.com/share/${m[1]}`);
  }
  if ((host === "vimeo.com" && (m = path.match(/^\/(\d+)/))) || (host === "player.vimeo.com" && (m = path.match(/^\/video\/(\d+)/)))) {
    return file("vimeo", raw, m[1]!, `https://vimeo.com/${m[1]}`);
  }
  if (host === "twitch.tv") {
    if ((m = path.match(/^\/videos\/(\d+)/))) return file("twitch", raw, m[1]!, `https://www.twitch.tv/videos/${m[1]}`);
    return unsupported(raw, "Twitch channel, not a VOD link; pick specific /videos/ links");
  }

  const known: [RegExp, string][] = [
    [/(^|\.)kick\.com$/, "OpusClip can't ingest Kick"],
    [/(^|\.)mediasilo\.com$/, "OpusClip can't ingest MediaSilo"],
    [/(^|\.)notion\.(so|site|com)$/, "a Notion page, not a video"],
    [/^docs\.google\.com$/, "a Google Doc, not a video (read it with campaign brief --doc)"],
    [/(^|\.)(instagram|tiktok|facebook|x|twitter)\.com$/, "a social post/profile, not source footage"],
    [/(^|\.)discord\.(gg|com)$/, "a Discord invite, not footage"],
  ];
  for (const [re, reason] of known) if (re.test(host)) return unsupported(raw, reason);
  return unsupported(raw, `unrecognized host ${host}`);
}
