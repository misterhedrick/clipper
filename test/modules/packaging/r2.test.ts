import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { r2Store } from "../../../src/modules/packaging/r2.js";
import { startFakeS3, type FakeS3 } from "../../helpers/fake-s3.js";

const config = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "AKIDTEST", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET_NAME: "clips" };

describe("r2Store (against a local S3-compatible server)", () => {
  let s3: FakeS3;
  beforeAll(async () => {
    s3 = await startFakeS3();
  });
  afterAll(async () => {
    await s3.close();
  });

  it("uploads small bodies with a signed PUT", async () => {
    const store = r2Store(config, { endpoint: s3.endpoint });
    await store.put("ready-to-post/a/b/caption.txt", "hello\n", "text/plain; charset=utf-8");
    expect(s3.objects.get("ready-to-post/a/b/caption.txt")).toEqual({ body: Buffer.from("hello\n"), contentType: "text/plain; charset=utf-8" });
    const put = s3.requests.find((r) => r.method === "PUT")!;
    expect(new URL(put.url, "http://x").pathname).toBe("/clips/ready-to-post/a/b/caption.txt");
    expect(put.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/auto\/s3\/aws4_request/);
  });

  it("streams a large body as a multipart upload without buffering it whole", async () => {
    const store = r2Store(config, { endpoint: s3.endpoint });
    const mb = (n: number) => Buffer.alloc(1024 * 1024, n);
    const chunks = Array.from({ length: 20 }, (_, i) => mb(i)); // 20 MB → 3 parts of 8 MB
    await store.put("ready-to-post/a/b/final.mp4", Readable.from(chunks), "video/mp4");
    expect(s3.objects.get("ready-to-post/a/b/final.mp4")!.body.equals(Buffer.concat(chunks))).toBe(true);
    expect(s3.requests.filter((r) => r.url.includes("partNumber=")).length).toBe(3);
  });

  it("signs time-limited download links", async () => {
    const url = new URL(await r2Store(config).signedUrl!("ready-to-post/a/b/final.mp4", 600));
    expect(url.host).toBe("acct.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/clips/ready-to-post/a/b/final.mp4");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });
});
