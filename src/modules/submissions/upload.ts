import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { audit } from "../../db/audit.js";
import { campaigns, sourceJobs, type FootageKind } from "../../db/schema.js";

// OpusClip's API refuses Google Drive links ("Unsupported video link"), so Drive
// videos go in through its upload link instead: the operator gets a signed
// Google Cloud Storage URL from opusclip_create_upload_link, and this copies the
// file from Drive into it, chunk by chunk, holding one chunk in memory and
// storing nothing. The job then submits the upload ID in place of the Drive link
// (buildSubmitParams), so reserve → submit → guard work as before.

export type UploadErrorCode = "not_found" | "invalid_state" | "invalid_argument" | "not_downloadable" | "upload_failed";

export class UploadError extends Error {
  constructor(
    public readonly code: UploadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

export type UploadCtx = { db: Db; actor: string; fetch?: typeof fetch };
export type UploadInput = { uploadUrl: string; uploadId: string; chunkBytes?: number };

/** Footage kinds OpusClip won't fetch by URL, which `source upload` must copy in first. */
export const needsUpload = (kind: FootageKind) => kind === "gdrive_file";

/** Public Drive files download here; `confirm=t` skips the large-file virus-scan page. */
export const driveDownloadUrl = (fileId: string) =>
  `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;

/** GCS resumable uploads take chunks in multiples of 256 KiB. */
const CHUNK_UNIT = 256 * 1024;
export const DEFAULT_CHUNK_BYTES = 64 * CHUNK_UNIT; // 16 MiB
const REQUEST_TIMEOUT_MS = 120_000;
const ATTEMPTS = 3;

function checkUploadUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UploadError("invalid_argument", "--upload-url isn't a URL");
  }
  // The server makes requests to this URL on the operator's say-so: only OpusClip's storage.
  if (url.protocol !== "https:" || url.hostname !== "storage.googleapis.com") {
    throw new UploadError("invalid_argument", "--upload-url must be the https://storage.googleapis.com/… upload_url from opusclip_create_upload_link");
  }
  return url.toString();
}

async function request(doFetch: typeof fetch, what: string, url: string, init: RequestInit, ok: (status: number) => boolean): Promise<Response> {
  let last = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await doFetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (ok(res.status)) return res;
      last = `HTTP ${res.status}${await res.text().then((t) => (t ? `: ${t.slice(0, 200)}` : "")).catch(() => "")}`;
      // Client errors won't change on retry, except throttling.
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      last = (err as Error).message;
    }
  }
  throw new UploadError("upload_failed", `${what} failed: ${last}`);
}

/** Size of a public Drive file, confirming Drive serves the video itself and not a sign-in or quota page. */
async function driveFileSize(doFetch: typeof fetch, fileId: string): Promise<number> {
  const url = driveDownloadUrl(fileId);
  let res: Response;
  try {
    res = await doFetch(url, { headers: { range: "bytes=0-0" }, redirect: "follow", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new UploadError("upload_failed", `Couldn't reach Drive for file ${fileId}: ${(err as Error).message}`);
  }
  await res.arrayBuffer().catch(() => undefined);
  const type = res.headers.get("content-type") ?? "";
  const total = Number(res.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]);
  if (res.status !== 206 || type.startsWith("text/html") || !Number.isInteger(total) || total <= 0) {
    throw new UploadError(
      "not_downloadable",
      `Drive didn't serve file ${fileId} as a download (HTTP ${res.status}, ${type || "no content type"}): it may be private, deleted, or over Drive's download quota`,
    );
  }
  return total;
}

/**
 * Copies a queued job's Drive video into OpusClip's storage and records the
 * upload ID. Idempotent: a job that already has an upload returns it unchanged.
 */
export async function uploadSource(ctx: UploadCtx, jobId: string, input: UploadInput) {
  const uploadUrl = checkUploadUrl(input.uploadUrl);
  const uploadId = input.uploadId.trim();
  if (!/^[\w-]{4,128}$/.test(uploadId)) throw new UploadError("invalid_argument", "--upload-id must be the upload_id from opusclip_create_upload_link");
  const chunk = input.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (chunk <= 0 || chunk % CHUNK_UNIT !== 0) throw new UploadError("invalid_argument", "chunk size must be a positive multiple of 256 KiB");

  const [row] = await ctx.db
    .select({ job: sourceJobs, campaign: campaigns })
    .from(sourceJobs)
    .innerJoin(campaigns, eq(campaigns.id, sourceJobs.campaignId))
    .where(eq(sourceJobs.id, jobId));
  if (!row) throw new UploadError("not_found", `No source job ${jobId}`);
  const { job, campaign } = row;
  if (job.opusclipUploadId) return { id: job.id, uploadId: job.opusclipUploadId, alreadyUploaded: true };
  if (!needsUpload(job.sourceKind)) throw new UploadError("invalid_state", `Job ${jobId} is a ${job.sourceKind}; OpusClip fetches that by URL, so there's nothing to upload`);
  if (job.status !== "queued") throw new UploadError("invalid_state", `Job ${jobId} is ${job.status}; only a queued job is uploaded (run \`source validate\` first)`);
  if (campaign.status !== "active" || !campaign.configConfirmedAt) {
    throw new UploadError("invalid_state", `Campaign "${campaign.title}" is ${campaign.status}; a person has to confirm it before anything is uploaded`);
  }
  const fileId = job.sourceKey.replace(/^gdrive:/, "");

  const doFetch = ctx.fetch ?? fetch;
  const started = Date.now();
  const total = await driveFileSize(doFetch, fileId);
  const session = await request(doFetch, "Starting the OpusClip upload", uploadUrl, { method: "POST", headers: { "x-goog-resumable": "start" }, body: "" }, (s) => s === 200 || s === 201);
  const sessionUrl = session.headers.get("location");
  await session.arrayBuffer().catch(() => undefined);
  if (!sessionUrl) throw new UploadError("upload_failed", "OpusClip's storage didn't return an upload session");

  for (let start = 0; start < total; start += chunk) {
    const end = Math.min(start + chunk, total) - 1;
    const part = await request(doFetch, `Downloading bytes ${start}-${end} from Drive`, driveDownloadUrl(fileId), { headers: { range: `bytes=${start}-${end}` } }, (s) => s === 206);
    const body = new Uint8Array(await part.arrayBuffer());
    if (body.byteLength !== end - start + 1) throw new UploadError("upload_failed", `Drive sent ${body.byteLength} bytes for range ${start}-${end}`);
    const last = end === total - 1;
    const put = await request(
      doFetch,
      `Uploading bytes ${start}-${end} to OpusClip`,
      sessionUrl,
      { method: "PUT", headers: { "content-range": `bytes ${start}-${end}/${total}` }, body },
      (s) => (last ? s === 200 || s === 201 : s === 308),
    );
    await put.arrayBuffer().catch(() => undefined);
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  await ctx.db.transaction(async (tx) => {
    await tx.update(sourceJobs).set({ opusclipUploadId: uploadId, sizeBytes: total, updatedAt: new Date() }).where(eq(sourceJobs.id, job.id));
    await audit(tx, { entityType: "source_job", entityId: job.id, action: "upload", actor: ctx.actor, details: { uploadId, bytes: total, seconds } });
  });
  return { id: job.id, uploadId, bytes: total, seconds };
}
