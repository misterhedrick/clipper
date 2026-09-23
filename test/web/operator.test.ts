import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { prepareArgv, runRemote } from "../../src/cli/remote.js";
import { createDb, type Db } from "../../src/db/client.js";
import { campaigns, candidateClips, sourceJobs, statusEvents } from "../../src/db/schema.js";
import { transition } from "../../src/db/transition.js";
import { resetTestDatabase, TEST_DATABASE_URL, truncateAll } from "../helpers/db.js";
import { validConfig } from "../helpers/config.js";
import { insertCampaign, insertSourceJob } from "../helpers/fixtures.js";

const OP_TOKEN = "operator-token-0123456789abcdef-0123456789";
const fixture = readFileSync(new URL("../fixtures/opusclip-list-clips.json", import.meta.url), "utf8");

describe("prepareArgv", () => {
  it("sends local file contents as stdin and never a path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clipper-"));
    const file = join(dir, "caption.txt");
    writeFileSync(file, "hello");
    expect(await prepareArgv(["candidate", "set-caption", "id", "--file", file])).toEqual({ argv: ["candidate", "set-caption", "id", "--file", "-"], stdin: "hello", needsStdin: false });
    expect(await prepareArgv(["candidate", "record-edit", "id", `--ops-file=${file}`, "--reason", "r"])).toMatchObject({ argv: ["candidate", "record-edit", "id", "--ops-file=-", "--reason", "r"], stdin: "hello" });
    expect(await prepareArgv(["candidate", "upsert", "j", "--file", "-"])).toMatchObject({ needsStdin: true, stdin: undefined });
    expect(await prepareArgv(["guard", "submit"])).toMatchObject({ needsStdin: true });
    await expect(prepareArgv(["candidate", "upsert", "j", "--file", join(dir, "missing.json")])).rejects.toThrow(/Can't read --file/);
  });
});

describe("runRemote transport", () => {
  it("wakes a sleeping service, then sends the command exactly once", async () => {
    const calls: string[] = [];
    let health = 0;
    const fake = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      if (url.endsWith("/health")) return new Response("", { status: ++health < 3 ? 503 : 200 });
      return new Response(JSON.stringify({ exitCode: 0, output: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await runRemote(["campaign", "list"], { url: "https://x.example/", token: "t", readStdin: async () => "", fetch: fake, sleep: async () => {} });
    expect(res).toEqual({ exitCode: 0, output: { ok: true } });
    expect(calls).toEqual(["GET /health", "GET /health", "GET /health", "POST /operator/run"]);
  });

  it("fails closed when the service can't be reached", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const res = await runRemote(["guard", "submit"], { url: "https://x.example", token: "t", readStdin: async () => "{}", fetch: down, wakeTimeoutMs: 0, sleep: async () => {} });
    expect(res).toMatchObject({ exitCode: 1, output: { error: { code: "remote_unreachable" } } });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("operator endpoint", () => {
  let db: Db;
  let pool: { end(): Promise<void> };
  let app: ReturnType<typeof buildApp>;
  let url: string;
  let jobId: string;
  const remote = (argv: string[], opts: { token?: string; stdin?: string } = {}) =>
    runRemote(argv, { url, token: opts.token ?? OP_TOKEN, readStdin: async () => opts.stdin ?? "" });

  beforeAll(async () => {
    await resetTestDatabase(TEST_DATABASE_URL!);
    ({ db, pool } = createDb(TEST_DATABASE_URL!));
    app = buildApp({ db, reviewerToken: "reviewer-token-0123456789-abcdef", operatorToken: OP_TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
    await pool?.end();
  });
  beforeEach(async () => {
    await truncateAll(db);
    const c = await insertCampaign(db, "cr-op", "active");
    await db.update(campaigns).set({ title: "Op", campaignType: "lf", config: validConfig() as never, configConfirmedAt: new Date(), configConfirmedBy: "reviewer:sam" }).where(eq(campaigns.id, c.id));
    const j = await insertSourceJob(db, c.id, "f1", { status: "submitting" });
    await transition(db, { entity: "source_job", id: j.id, to: "project_created", actor: "claude-operator", set: { opusclipProjectId: "P123" } });
    jobId = j.id;
  });

  it("refuses requests without the operator token (the reviewer token doesn't work either)", async () => {
    for (const auth of [undefined, "Bearer wrong", "Bearer reviewer-token-0123456789-abcdef"]) {
      const res = await app.inject({ method: "POST", url: "/operator/run", headers: auth ? { authorization: auth } : {}, payload: { argv: ["campaign", "list"] } });
      expect(res.statusCode).toBe(401);
    }
    expect(await remote(["campaign", "list"], { token: "nope" })).toMatchObject({ exitCode: 1, output: { error: { code: "remote_auth" } } });
  });

  it("runs commands against the app's database, as the operator", async () => {
    expect(await remote(["campaign", "list"])).toMatchObject({ exitCode: 0, output: { campaigns: [expect.objectContaining({ title: "Op" })] } });

    // A local file travels as stdin; the write lands in the server's database, attributed to the operator.
    const dir = mkdtempSync(join(tmpdir(), "clipper-"));
    writeFileSync(join(dir, "clips.json"), fixture);
    expect(await remote(["candidate", "upsert", jobId, "--file", join(dir, "clips.json")])).toMatchObject({ exitCode: 0, output: { created: 3, jobStatus: "candidates_ready" } });
    expect(await db.select().from(candidateClips)).toHaveLength(3);
    const created = await db.select().from(statusEvents).where(and(eq(statusEvents.entityType, "candidate_clip"), eq(statusEvents.toStatus, "awaiting_review")));
    expect(new Set(created.map((e) => e.actor))).toEqual(new Set(["claude-operator"]));
  });

  it("never reads a file on the server", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/operator/run",
      headers: { authorization: `Bearer ${OP_TOKEN}` },
      payload: { argv: ["candidate", "upsert", jobId, "--file", "/etc/passwd"] },
    });
    expect(res.json()).toMatchObject({ exitCode: 1, output: { error: { code: "usage", message: expect.stringContaining("not server paths") } } });
  });

  it("keeps the guard failing closed, and the human-only rules in force", async () => {
    const guard = await remote(["guard", "submit"], { stdin: JSON.stringify({ tool_input: { title: `clipper:${jobId}`, videoUrl: "x" } }) });
    expect(guard.exitCode).toBe(2);
    expect(guard.output).toMatchObject({ allow: false });

    // There's still no approve command, remote or not.
    expect(await remote(["candidate", "approve", "x"])).toMatchObject({ exitCode: 1, output: { error: { code: "usage" } } });
    expect((await db.select().from(sourceJobs).where(eq(sourceJobs.id, jobId)))[0]!.status).toBe("project_created");
  });

  it("is off unless OPERATOR_TOKEN is configured", async () => {
    const off = buildApp({ db });
    expect((await off.inject({ method: "POST", url: "/operator/run", payload: { argv: ["campaign", "list"] } })).statusCode).toBe(404);
    await off.close();
  });
});
