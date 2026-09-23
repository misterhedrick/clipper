import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";
import type { BundleStore } from "./index.js";

// Cloudflare R2 through its S3-compatible API. Uploads go through lib-storage's
// Upload, which streams: bodies over 5 MB are sent as a multipart upload in
// parts, so a clip export is never held in memory whole.

export type R2Config = {
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
};

export function r2Store(config: R2Config, opts: { endpoint?: string } = {}): BundleStore {
  const client = new S3Client({
    region: "auto",
    endpoint: opts.endpoint ?? `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY },
    forcePathStyle: true,
  });
  const Bucket = config.R2_BUCKET_NAME;
  return {
    async put(key: string, body: Readable | Buffer | string, contentType: string) {
      await new Upload({ client, params: { Bucket, Key: key, Body: body, ContentType: contentType }, queueSize: 4, partSize: 8 * 1024 * 1024 }).done();
    },
    signedUrl: (key: string, expiresInSec = 3600) => getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: expiresInSec }),
  };
}
