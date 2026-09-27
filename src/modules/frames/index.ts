import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

// Pulls still frames out of a clip's preview video so the operator can look at
// what's on screen (burned-in captions, the product, overlays, watermarks) before
// recording a visual review. Runs on the operator's machine: the frames are for
// Claude to read, so they're written to a local folder, never to the database.
//
// ffmpeg comes from the optional `ffmpeg-static` package, or FFMPEG_PATH, or PATH.

const run = promisify(execFile);

export type FramesErrorCode = "ffmpeg_missing" | "download_failed" | "extract_failed" | "invalid_argument";

export class FramesError extends Error {
  constructor(
    public readonly code: FramesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FramesError";
  }
}

/** Frames every this many seconds after the opening, unless the caller asks otherwise. */
export const DEFAULT_EVERY_SEC = 2;
/** The opening is sampled densely: briefs judge the first 2 seconds (the hook). */
const OPENING = [0.2, 0.7, 1.2, 1.7];
const SHEET_COLS = 5;
const SHEET_MAX = 20;
const round = (t: number) => Math.round(t * 10) / 10;

/** When to sample a clip: the dense opening, then every `everySec`, then the last moment. */
export function planFrameTimes(durationSec: number, everySec = DEFAULT_EVERY_SEC): number[] {
  if (!(durationSec > 0)) throw new FramesError("invalid_argument", "The clip's duration must be known and positive");
  if (!(everySec > 0)) throw new FramesError("invalid_argument", "--every must be a positive number of seconds");
  const end = Math.max(0, durationSec - 0.25);
  const times = OPENING.filter((t) => t < end);
  for (let t = 2; t < end; t += everySec) times.push(round(t));
  if (!times.length || end - times[times.length - 1]! >= 0.5) times.push(round(end));
  return [...new Set(times)];
}

/** The ffmpeg binary to use: FFMPEG_PATH, else ffmpeg-static, else `ffmpeg` on PATH. */
export async function findFfmpeg(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const candidates: string[] = [];
  if (env.FFMPEG_PATH) candidates.push(env.FFMPEG_PATH);
  try {
    const mod = (await import("ffmpeg-static")) as unknown as { default?: string | null };
    if (mod.default) candidates.push(mod.default);
  } catch {
    // Optional dependency not installed.
  }
  candidates.push("ffmpeg");
  for (const bin of candidates) {
    try {
      await run(bin, ["-version"]);
      return bin;
    } catch {
      // try the next one
    }
  }
  throw new FramesError("ffmpeg_missing", "No ffmpeg found: run `npm install` (it brings ffmpeg-static) or set FFMPEG_PATH");
}

async function ffmpeg(bin: string, args: string[], what: string) {
  try {
    return await run(bin, ["-v", "error", "-y", ...args], { maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new FramesError("extract_failed", `${what}: ${stderr || (err as Error).message}`);
  }
}

/** Reads a video's length from ffmpeg's header dump. */
async function probeDuration(bin: string, file: string): Promise<number | undefined> {
  // `ffmpeg -i` with no output always exits non-zero; the header is on stderr either way.
  const stderr = await run(bin, ["-hide_banner", "-i", file]).then(
    (r) => r.stderr,
    (err: { stderr?: string }) => err.stderr ?? "",
  );
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
}

export type FrameSheet = { file: string; cols: number; rows: number; times: number[] };

export type ExtractedFrames = {
  previewFile: string;
  durationSec: number;
  frames: { t: number; file: string }[];
  /** Contact sheets, frames left to right then top to bottom, at the listed times. */
  sheets: FrameSheet[];
  /** Full-size stills at the requested `at` times (e.g. to read a caption word). */
  stills: { t: number; file: string }[];
};

export type ExtractOptions = {
  url: string;
  outDir: string;
  /** Known length; probed from the file when absent. */
  durationSec?: number;
  everySec?: number;
  at?: number[];
  fetch?: typeof fetch;
  ffmpegPath?: string;
};

/** Downloads the preview once, then writes sampled frames, contact sheets and any requested stills. */
export async function extractFrames(opts: ExtractOptions): Promise<ExtractedFrames> {
  const bin = opts.ffmpegPath ?? (await findFfmpeg());
  const doFetch = opts.fetch ?? fetch;
  await mkdir(opts.outDir, { recursive: true });

  const previewFile = join(opts.outDir, "preview.mp4");
  let res: Response;
  try {
    res = await doFetch(opts.url, { signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw new FramesError("download_failed", `Downloading the preview failed: ${(err as Error).message}`);
  }
  if (!res.ok) throw new FramesError("download_failed", `Downloading the preview answered HTTP ${res.status} (preview links expire; re-run \`candidate upsert\` with a fresh opusclip_list_clips)`);
  await writeFile(previewFile, Buffer.from(await res.arrayBuffer()));

  const durationSec = opts.durationSec ?? (await probeDuration(bin, previewFile));
  if (!durationSec) throw new FramesError("extract_failed", "Couldn't read the preview's duration");

  const times = planFrameTimes(durationSec, opts.everySec);
  const frames: ExtractedFrames["frames"] = [];
  for (const [i, t] of times.entries()) {
    const file = join(opts.outDir, `frame_${String(i).padStart(3, "0")}.jpg`);
    await ffmpeg(bin, ["-ss", String(t), "-i", previewFile, "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "3", file], `Frame at ${t}s`);
    frames.push({ t, file });
  }

  const sheets: FrameSheet[] = [];
  for (let start = 0; start < frames.length; start += SHEET_MAX) {
    const chunk = frames.slice(start, start + SHEET_MAX);
    const rows = Math.ceil(chunk.length / SHEET_COLS);
    const file = join(opts.outDir, `sheet_${sheets.length + 1}.jpg`);
    await ffmpeg(
      bin,
      [
        "-start_number", String(start),
        "-i", join(opts.outDir, "frame_%03d.jpg"),
        "-vf", `trim=end_frame=${chunk.length},scale=240:-2,tile=${SHEET_COLS}x${rows}:padding=6:color=white`,
        "-frames:v", "1",
        file,
      ],
      `Contact sheet ${sheets.length + 1}`,
    );
    sheets.push({ file, cols: SHEET_COLS, rows, times: chunk.map((f) => f.t) });
  }

  const stills: ExtractedFrames["stills"] = [];
  for (const t of opts.at ?? []) {
    if (!(t >= 0 && t < durationSec)) throw new FramesError("invalid_argument", `--at ${t} is outside the clip (0–${durationSec}s)`);
    const file = join(opts.outDir, `at_${t.toFixed(1)}s.jpg`);
    await ffmpeg(bin, ["-ss", String(t), "-i", previewFile, "-frames:v", "1", "-q:v", "2", file], `Still at ${t}s`);
    stills.push({ t, file });
  }

  return { previewFile, durationSec, frames, sheets, stills };
}
