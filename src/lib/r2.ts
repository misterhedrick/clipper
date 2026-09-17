import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { config } from "../config.js";

export const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY,
  },
});

/** Small in-memory payloads (caption.txt, clip-metadata.json) — fine to buffer. */
export async function putSmallObject(key: string, body: string, contentType: string): Promise<void> {
  await r2Client.send(
    new PutObjectCommand({ Bucket: config.R2_BUCKET_NAME, Key: key, Body: body, ContentType: contentType }),
  );
}

/**
 * Streams a remote URL's response body directly into R2 via multipart
 * upload — never buffers the whole file in memory, consistent with the
 * project's "no unnecessary file handling" principle even though this is
 * the export step, not the original intake step.
 */
export async function streamUrlToR2(sourceUrl: string, key: string, contentType: string): Promise<void> {
  const res = await fetch(sourceUrl);
  if (!res.ok || !res.body) {
    throw new Error(`Fetching export source ${sourceUrl} failed with HTTP ${res.status}`);
  }

  const upload = new Upload({
    client: r2Client,
    params: {
      Bucket: config.R2_BUCKET_NAME,
      Key: key,
      Body: res.body as unknown as ReadableStream,
      ContentType: contentType,
    },
  });

  await upload.done();
}
