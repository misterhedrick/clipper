import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A minimal S3-compatible server for exercising the real AWS SDK path (request
// signing, single PUT and multipart uploads) without Cloudflare. It implements
// just PutObject, CreateMultipartUpload, UploadPart and CompleteMultipartUpload.

export type FakeS3 = {
  endpoint: string;
  objects: Map<string, { body: Buffer; contentType?: string }>;
  requests: { method: string; url: string; authorization?: string }[];
  close(): Promise<void>;
};

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

/** The SDK may send aws-chunked bodies when streaming; strip the chunk framing. */
function decodeAwsChunked(buf: Buffer): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const lineEnd = buf.indexOf("\r\n", i);
    if (lineEnd < 0) break;
    const size = parseInt(buf.subarray(i, lineEnd).toString().split(";")[0]!, 16);
    if (!size) break;
    out.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size));
    i = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(out);
}

export async function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, { body: Buffer; contentType?: string }>();
  const parts = new Map<string, Map<number, Buffer>>();
  const requests: FakeS3["requests"] = [];
  let uploads = 0;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    requests.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization });
    const key = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//, ""));
    let body: Buffer = await readBody(req);
    if (String(req.headers["content-encoding"] ?? "").includes("aws-chunked") || req.headers["x-amz-decoded-content-length"]) {
      body = decodeAwsChunked(body);
    }
    const xml = (s: string) => {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>${s}`);
    };

    if (req.method === "POST" && url.searchParams.has("uploads")) {
      const id = `u${++uploads}`;
      parts.set(id, new Map());
      return xml(`<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (req.method === "PUT" && url.searchParams.has("uploadId")) {
      parts.get(url.searchParams.get("uploadId")!)!.set(Number(url.searchParams.get("partNumber")), body);
      res.writeHead(200, { etag: `"p${url.searchParams.get("partNumber")}"` });
      return res.end();
    }
    if (req.method === "POST" && url.searchParams.has("uploadId")) {
      const p = parts.get(url.searchParams.get("uploadId")!)!;
      const joined = Buffer.concat([...p.entries()].sort(([a], [b]) => a - b).map(([, b]) => b));
      objects.set(key, { body: joined, contentType: objects.get(`__ct:${key}`)?.contentType });
      return xml(`<CompleteMultipartUploadResult><Key>${key}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`);
    }
    if (req.method === "PUT") {
      objects.set(key, { body, contentType: req.headers["content-type"] });
      res.writeHead(200, { etag: '"x"' });
      return res.end();
    }
    res.writeHead(400);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
