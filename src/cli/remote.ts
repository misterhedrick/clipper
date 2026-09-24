import { readFile } from "node:fs/promises";
import { DEFAULT_APP_URL } from "../config.js";
import type { RunResult } from "./run.js";

// Remote mode for the `clipper` CLI. When CLIPPER_REMOTE_URL is set (the
// operator's cloud environment, which can only make HTTPS requests), each
// command is sent to the review app's POST /operator/run and runs there against
// the database. File arguments are read here and sent as stdin, so the server
// never reads its own disk on the operator's say-so.
//
// A command is sent exactly once: some aren't idempotent (reserve), so only the
// wake-up health check is retried. Anything that isn't a clean answer from the
// server is a non-zero exit, so the submit guard fails closed.

export type RemoteOptions = {
  url: string;
  token: string;
  readStdin: () => Promise<string>;
  fetch?: typeof fetch;
  /** How long to keep waking a sleeping free-plan service (default 120 s). */
  wakeTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/** The deployed review app. Not a secret; CLIPPER_REMOTE_URL overrides it. */
export const DEFAULT_REMOTE_URL = DEFAULT_APP_URL;

/**
 * Where commands run. Remote mode is on when an operator token is present (the
 * cloud operator's environment); without one, the CLI uses the local database.
 */
export function remoteTarget(env: NodeJS.ProcessEnv): { url: string; token: string } | undefined {
  const token = env.CLIPPER_OPERATOR_TOKEN?.trim();
  const url = env.CLIPPER_REMOTE_URL?.trim();
  if (!token && !url) return undefined;
  return { url: url || DEFAULT_REMOTE_URL, token: token ?? "" };
}

const FILE_OPTIONS = ["--file", "--ops-file"];
const LONG_COMMANDS = new Set(["package"]);

const fail = (code: string, message: string, exitCode = 1): RunResult => ({ exitCode, output: { error: { code, message } } });

/** Swaps a local file argument for its contents on stdin. Returns the argv to send and whether stdin is needed. */
export async function prepareArgv(argv: string[]): Promise<{ argv: string[]; stdin?: string; needsStdin: boolean }> {
  const out = [...argv];
  let stdin: string | undefined;
  let needsStdin = argv[0] === "guard" && argv[1] === "submit";
  let files = 0;
  for (let i = 0; i < out.length; i++) {
    const arg = out[i]!;
    const eq = FILE_OPTIONS.find((o) => arg.startsWith(`${o}=`));
    const name = eq ?? (FILE_OPTIONS.includes(arg) ? arg : undefined);
    if (!name) continue;
    const valueIndex = eq ? i : i + 1;
    const value = eq ? arg.slice(name.length + 1) : out[i + 1];
    if (value === undefined) continue; // let the server report the usage error
    if (++files > 1) throw new Error("Only one file argument per command");
    if (value === "-") needsStdin = true;
    else {
      stdin = await readFile(value, "utf8").catch(() => {
        throw new Error(`Can't read ${name} ${value}`);
      });
    }
    out[valueIndex] = eq ? `${name}=-` : "-";
  }
  return { argv: out, stdin, needsStdin };
}

async function proxiedFetch(): Promise<typeof fetch> {
  // Node's own fetch ignores HTTPS_PROXY; undici's agent honours it and NO_PROXY.
  // Imported lazily: loading the undici package replaces Node's global dispatcher,
  // after which the built-in fetch stops decoding gzip bodies (Drive listings
  // arrive as binary). Only remote mode, which makes no other requests, loads it.
  const { EnvHttpProxyAgent, fetch: undiciFetch } = await import("undici");
  const dispatcher = new EnvHttpProxyAgent();
  return ((input: string | URL, init?: RequestInit) => undiciFetch(input as string, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
}

export async function runRemote(argv: string[], opts: RemoteOptions): Promise<RunResult> {
  const base = opts.url.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? (await proxiedFetch());
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let prepared;
  try {
    prepared = await prepareArgv(argv);
  } catch (err) {
    return fail("usage", (err as Error).message);
  }
  const stdin = prepared.stdin ?? (prepared.needsStdin ? await opts.readStdin() : undefined);

  // Wake a sleeping free-plan service before sending the command itself.
  const deadline = Date.now() + (opts.wakeTimeoutMs ?? 120_000);
  let lastProblem = "";
  for (;;) {
    try {
      const res = await doFetch(`${base}/health`, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) break;
      lastProblem = `health check answered HTTP ${res.status}`;
    } catch (err) {
      lastProblem = (err as Error).message;
    }
    if (Date.now() >= deadline) return fail("remote_unreachable", `Can't reach ${base}: ${lastProblem}`);
    await sleep(5_000);
  }

  let res: Response;
  try {
    res = await doFetch(`${base}/operator/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({ argv: prepared.argv, ...(stdin !== undefined ? { stdin } : {}) }),
      signal: AbortSignal.timeout(LONG_COMMANDS.has(argv[0] ?? "") ? 45 * 60_000 : 5 * 60_000),
    });
  } catch (err) {
    // The command may or may not have run; the caller should check state before repeating it.
    return fail("remote_unreachable", `Sending the command to ${base} failed (it may or may not have run): ${(err as Error).message}`);
  }
  const text = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return fail("remote_failed", `${base} answered HTTP ${res.status} with a non-JSON body`);
  }
  if (res.status === 401) return { exitCode: 1, output: payload };
  const result = payload as Partial<RunResult>;
  if (!res.ok || typeof result.exitCode !== "number" || !("output" in result)) {
    return { exitCode: 1, output: (payload as { error?: unknown }).error ? payload : { error: { code: "remote_failed", message: `HTTP ${res.status}` } } };
  }
  return { exitCode: result.exitCode, output: result.output };
}
