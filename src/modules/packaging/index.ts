import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { and, asc, eq, like } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { audit } from "../../db/audit.js";
import { campaigns, candidateClips, sourceJobs, statusEvents } from "../../db/schema.js";
import { transition } from "../../db/transition.js";
import { validateCampaignConfig } from "../campaign-config/index.js";
import { validateCaption } from "../compliance/index.js";

// Turns a clip a person approved into a Ready-to-Post bundle in our own storage:
//
//   ready-to-post/<campaign>/<clip>/final.mp4 · caption.txt · thumbnail.jpg · clip-metadata.json
//
// The export streams from OpusClip straight into storage. clip-metadata.json is
// written last, so its presence means the bundle is complete. Nothing a
// reviewer didn't approve is ever packaged.

/** Where bundles go. R2 in production (./r2.ts); an in-memory store in tests. */
export type BundleStore = {
  put(key: string, body: Readable | Buffer | string, contentType: string): Promise<void>;
  /** A time-limited download link, for the review page. */
  signedUrl?(key: string, expiresInSec?: number): Promise<string>;
};

export type PackagingErrorCode = "not_found" | "invalid_state" | "invalid_argument" | "export_unavailable" | "upload_failed";

export class PackagingError extends Error {
  constructor(
    public readonly code: PackagingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PackagingError";
  }
}

export type PackagingCtx = { db: Db; actor: string; store?: BundleStore; fetch?: typeof fetch; now?: () => Date };

export const BUNDLE_ROOT = "ready-to-post";
export const BUNDLE_FILES = ["final.mp4", "caption.txt", "thumbnail.jpg", "clip-metadata.json"] as const;

async function load(db: Db, id: string) {
  const [row] = await db
    .select({ clip: candidateClips, job: sourceJobs, campaign: campaigns })
    .from(candidateClips)
    .innerJoin(sourceJobs, eq(sourceJobs.id, candidateClips.sourceJobId))
    .innerJoin(campaigns, eq(campaigns.id, sourceJobs.campaignId))
    .where(eq(candidateClips.id, id));
  if (!row) throw new PackagingError("not_found", `No candidate ${id}`);
  return row;
}

/** The reviewer's approval event. Packaging requires one, whatever the status column says. */
async function approvalEvent(db: Db, id: string) {
  const [ev] = await db
    .select()
    .from(statusEvents)
    .where(and(eq(statusEvents.entityType, "candidate_clip"), eq(statusEvents.entityId, id), eq(statusEvents.toStatus, "approved"), like(statusEvents.actor, "reviewer:%")))
    .orderBy(asc(statusEvents.createdAt))
    .limit(1);
  return ev;
}

export const slug = (s: string | null | undefined, max = 40) =>
  (s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "") || "untitled";

export function bundlePrefix(campaign: { id: string; title: string | null }, clip: { id: string; title: string | null }) {
  return `${BUNDLE_ROOT}/${slug(campaign.title)}-${campaign.id.slice(0, 8)}/${slug(clip.title)}-${clip.id.slice(0, 8)}/`;
}

const httpsUrl = (u: string) => {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};

/** Stores the HD export URL the operator got from opusclip_export_clip. Approved candidates only. */
export async function recordExport(ctx: PackagingCtx, id: string, url: string) {
  if (!httpsUrl(url.trim())) throw new PackagingError("invalid_argument", "--url must be the https export_url from opusclip_export_clip");
  const { clip } = await load(ctx.db, id);
  if (clip.status !== "approved" && clip.status !== "exporting") {
    throw new PackagingError("invalid_state", `Candidate ${id} is ${clip.status}; exports are recorded only for approved candidates`);
  }
  await ctx.db.transaction(async (tx) => {
    await tx.update(candidateClips).set({ exportUrl: url.trim() }).where(eq(candidateClips.id, id));
    await audit(tx, { entityType: "candidate_clip", entityId: id, action: "record_export", actor: ctx.actor, details: { url: url.trim(), previous: clip.exportUrl } });
  });
  return { id, status: clip.status, exportUrl: url.trim() };
}

async function download(fetchImpl: typeof fetch, url: string, what: string) {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(30 * 60_000) });
  } catch (err) {
    throw new PackagingError("export_unavailable", `Couldn't download the ${what}: ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) {
    const hint = [401, 403, 404, 410].includes(res.status) ? " (the link has probably expired: export again and re-record it)" : "";
    throw new PackagingError("export_unavailable", `Downloading the ${what} returned HTTP ${res.status}${hint}`);
  }
  return res;
}

/**
 * Packages an approved candidate into its Ready-to-Post bundle and moves it to
 * ready_to_post. Safe to re-run: a packaged clip is returned as is, and a run
 * that failed midway (left in exporting) starts over, overwriting the same keys.
 */
export async function packageCandidate(ctx: PackagingCtx, id: string) {
  const { clip, job, campaign } = await load(ctx.db, id);
  if ((clip.status === "ready_to_post" || clip.status === "posted") && clip.packageKey) {
    return { id, status: clip.status, packageKey: clip.packageKey, alreadyPackaged: true };
  }
  if (clip.status !== "approved" && clip.status !== "exporting") {
    throw new PackagingError("invalid_state", `Candidate ${id} is ${clip.status}; only clips a reviewer approved are packaged`);
  }
  const approval = await approvalEvent(ctx.db, id);
  if (!approval) throw new PackagingError("invalid_state", `Candidate ${id} has no approval by a reviewer on record; refusing to package it`);
  if (!clip.exportUrl) throw new PackagingError("invalid_state", `No export recorded for ${id}: run opusclip_export_clip, then \`clipper candidate record-export\``);
  if (!clip.caption) throw new PackagingError("invalid_state", `Candidate ${id} has no caption`);
  const caption = validateCaption(clip.caption, validateCampaignConfig(campaign.config));
  if (!caption.valid) throw new PackagingError("invalid_state", `The caption no longer meets the campaign's rules: ${caption.issues.map((i) => i.message).join("; ")}`);
  if (!ctx.store) throw new PackagingError("invalid_state", "No bundle storage configured (R2_* variables)");
  const store = ctx.store;
  const fetchImpl = ctx.fetch ?? fetch;

  const prefix = bundlePrefix(campaign, clip);
  if (clip.status === "approved") {
    await transition(ctx.db, { entity: "candidate_clip", id, to: "exporting", actor: ctx.actor, reason: `packaging to ${prefix}`, expectFrom: ["approved"] });
  }

  const files: Record<string, { bytes?: number; missing?: string }> = {};
  try {
    const video = await download(fetchImpl, clip.exportUrl, "HD export");
    const counted = countBytes(Readable.fromWeb(video.body as unknown as WebReadableStream<Uint8Array>));
    try {
      await store.put(`${prefix}final.mp4`, counted.stream, "video/mp4");
    } catch (err) {
      throw new PackagingError("upload_failed", `Uploading final.mp4 failed: ${(err as Error).message}`);
    }
    files["final.mp4"] = { bytes: counted.bytes() };

    if (clip.thumbnailUrl) {
      try {
        const thumb = await download(fetchImpl, clip.thumbnailUrl, "thumbnail");
        const buf = Buffer.from(await thumb.arrayBuffer());
        await store.put(`${prefix}thumbnail.jpg`, buf, thumb.headers.get("content-type") ?? "image/jpeg");
        files["thumbnail.jpg"] = { bytes: buf.length };
      } catch (err) {
        // A missing thumbnail doesn't block posting; say so in the metadata instead.
        files["thumbnail.jpg"] = { missing: (err as Error).message };
      }
    } else {
      files["thumbnail.jpg"] = { missing: "OpusClip gave no thumbnail URL" };
    }

    const captionText = `${clip.caption}\n`;
    await put(store, `${prefix}caption.txt`, captionText, "text/plain; charset=utf-8");
    files["caption.txt"] = { bytes: Buffer.byteLength(captionText) };

    const packagedAt = ctx.now?.() ?? new Date();
    const metadata = {
      candidateId: clip.id,
      title: clip.title,
      description: clip.description,
      durationMs: clip.durationMs,
      caption: clip.caption,
      campaign: { id: campaign.id, title: campaign.title, brand: campaign.brand, contentRewardsUrl: campaign.contentRewardsUrl, platforms: campaign.platforms },
      source: { jobId: job.id, name: job.sourceName, path: job.sourcePath, kind: job.sourceKind, url: job.sourceUrl },
      opusclip: { projectId: job.opusclipProjectId, clipId: clip.opusclipClipId, score: clip.opusclipScore === null ? null : Number(clip.opusclipScore), subScores: clip.opusclipSubScores },
      checks: clip.checkResults,
      prescreen: clip.prescreenVerdict ? { verdict: clip.prescreenVerdict, notes: clip.prescreenNotes } : null,
      approval: { by: approval.actor, at: approval.createdAt, notes: clip.reviewNotes },
      edits: clip.editLog,
      files,
      packagedAt,
      packagedBy: ctx.actor,
    };
    await put(store, `${prefix}clip-metadata.json`, `${JSON.stringify(metadata, null, 2)}\n`, "application/json");
    files["clip-metadata.json"] = {};

    await transition(ctx.db, {
      entity: "candidate_clip",
      id,
      to: "ready_to_post",
      actor: ctx.actor,
      reason: `packaged to ${prefix}`,
      expectFrom: ["exporting"],
      set: { packageKey: prefix, packagedAt },
    });
    return { id, status: "ready_to_post" as const, packageKey: prefix, files, alreadyPackaged: false };
  } catch (err) {
    const message = (err as Error).message;
    await transition(ctx.db, { entity: "candidate_clip", id, to: "approved", actor: ctx.actor, reason: `packaging failed: ${message.slice(0, 300)}`, errorDetails: { error: message } });
    if (err instanceof PackagingError) throw err;
    throw new PackagingError("upload_failed", message);
  }
}

async function put(store: BundleStore, key: string, body: string, contentType: string) {
  try {
    await store.put(key, body, contentType);
  } catch (err) {
    throw new PackagingError("upload_failed", `Uploading ${key.split("/").pop()} failed: ${(err as Error).message}`);
  }
}

/** Passes a stream through unchanged while counting its bytes (without putting the source into flowing mode early). */
function countBytes(source: Readable) {
  let n = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      n += chunk.length;
      done(null, chunk);
    },
  });
  source.on("error", (err) => counter.destroy(err));
  return { stream: source.pipe(counter), bytes: () => n };
}
