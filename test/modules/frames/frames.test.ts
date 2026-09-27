import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../../src/cli/run.js";
import { extractFrames, findFfmpeg, FramesError, planFrameTimes } from "../../../src/modules/frames/index.js";

describe("planFrameTimes", () => {
  it("samples the opening densely, then every few seconds, then the end", () => {
    expect(planFrameTimes(9)).toEqual([0.2, 0.7, 1.2, 1.7, 2, 4, 6, 8, 8.8]);
    expect(planFrameTimes(9, 3)).toEqual([0.2, 0.7, 1.2, 1.7, 2, 5, 8, 8.8]);
    expect(planFrameTimes(1)).toEqual([0.2, 0.7]);
    expect(() => planFrameTimes(0)).toThrow(FramesError);
    expect(() => planFrameTimes(10, 0)).toThrow(/--every/);
  });
});

let ffmpeg: string | undefined;
try {
  ffmpeg = await findFfmpeg();
} catch {
  ffmpeg = undefined;
}

describe.skipIf(!ffmpeg)("extractFrames (real ffmpeg)", () => {
  let dir: string;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "clipper-frames-test-"));
    const video = join(dir, "clip.mp4");
    // A 7-second portrait test pattern stands in for an OpusClip preview.
    await promisify(execFile)(ffmpeg!, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=360x640:rate=25", "-t", "7", "-pix_fmt", "yuv420p", video]);
    const body = readFileSync(video);
    server = createServer((req, res) => {
      if (req.url === "/clip.mp4") res.writeHead(200, { "content-type": "video/mp4" }).end(body);
      else res.writeHead(403).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes frames, contact sheets and stills, probing the length when unknown", async () => {
    const out = join(dir, "out");
    const r = await extractFrames({ url: `${url}/clip.mp4`, outDir: out, at: [3.5], ffmpegPath: ffmpeg });
    expect(r.durationSec).toBeCloseTo(7, 0);
    expect(r.frames.map((f) => f.t)).toEqual([0.2, 0.7, 1.2, 1.7, 2, 4, 6, 6.8]);
    expect(r.sheets).toEqual([{ file: join(out, "sheet_1.jpg"), cols: 5, rows: 2, times: [0.2, 0.7, 1.2, 1.7, 2, 4, 6, 6.8] }]);
    expect(r.stills).toEqual([{ t: 3.5, file: join(out, "at_3.5s.jpg") }]);
    for (const f of [...r.frames, ...r.sheets, ...r.stills]) expect(existsSync(f.file)).toBe(true);
  });

  it("reports an expired preview link and a still outside the clip", async () => {
    await expect(extractFrames({ url: `${url}/expired.mp4`, outDir: join(dir, "x"), ffmpegPath: ffmpeg })).rejects.toMatchObject({ code: "download_failed" });
    await expect(extractFrames({ url: `${url}/clip.mp4`, outDir: join(dir, "y"), durationSec: 7, at: [9], ffmpegPath: ffmpeg })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("`candidate frames` looks the candidate up through the given lookup (remote mode) and writes locally", async () => {
    const out = join(dir, "cli");
    const looked: string[] = [];
    const showCandidate = async (id: string) => {
      looked.push(id);
      return { exitCode: 0, output: { previewUrl: `${url}/clip.mp4`, durationMs: 7000, title: "Test", visualChecks: ["aspect_ratio"] } };
    };
    const res = await run(["candidate", "frames", "c-1", "--out", out, "--every", "3"], { showCandidate, env: {} });
    expect(res.exitCode).toBe(0);
    expect(looked).toEqual(["c-1"]);
    expect(res.output).toMatchObject({ id: "c-1", visualChecks: ["aspect_ratio"], outDir: out, frames: 7, sheets: [{ times: [0.2, 0.7, 1.2, 1.7, 2, 5, 6.8] }] });

    const missing = await run(["candidate", "frames", "c-2"], { showCandidate: async () => ({ exitCode: 1, output: { error: { code: "not_found", message: "No candidate c-2" } } }), env: {} });
    expect(missing).toEqual({ exitCode: 1, output: { error: { code: "not_found", message: "No candidate c-2" } } });
  });
});
