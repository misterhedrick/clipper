import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { TEST_DATABASE_URL } from "./helpers/db.js";

describe.skipIf(!TEST_DATABASE_URL)("GET /health", () => {
  const { db, pool } = createDb(TEST_DATABASE_URL ?? "postgres://unused");
  const app = buildApp({ db });

  beforeAll(() => app.ready());
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("returns 200 when the database is reachable", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /health with an unreachable database", () => {
  // Port 1 on localhost refuses connections immediately.
  const { db, pool } = createDb("postgres://u:p@127.0.0.1:1/none");
  const app = buildApp({ db });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("returns 503", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "unavailable" });
  });
});
