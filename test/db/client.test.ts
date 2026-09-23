import { describe, expect, it } from "vitest";
import { poolConfig } from "../../src/db/client.js";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
const URL_ = "postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require";

describe("poolConfig", () => {
  it("passes the URL through when no CA is configured", () => {
    expect(poolConfig(URL_, undefined)).toEqual({ connectionString: URL_ });
    expect(poolConfig(URL_, "  ")).toEqual({ connectionString: URL_ });
  });

  it("verifies TLS against a configured CA, dropping URL ssl params that would override it", () => {
    const cfg = poolConfig(URL_, PEM);
    expect(cfg.ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
    expect(cfg.connectionString).toBe("postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres");
  });

  it("accepts a PEM pasted with literal \\n escapes, and rejects non-PEM values", () => {
    expect(poolConfig(URL_, PEM.replace(/\n/g, "\\n")).ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
    expect(() => poolConfig(URL_, "not a cert")).toThrow(/PEM certificate/);
  });
});
