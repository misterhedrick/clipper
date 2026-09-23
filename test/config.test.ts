import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const fullEnv = {
  DATABASE_URL: "postgres://u:p@localhost:5432/clipper",
  REVIEWER_TOKEN: "a-reviewer-token-that-is-long-enough",
  OPUSCLIP_DAILY_CREDIT_BUDGET: "120",
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "access",
  R2_SECRET_ACCESS_KEY: "secret-value-do-not-leak",
  R2_BUCKET_NAME: "bucket",
  NOTIFY_WEBHOOK_URL: "https://hooks.example.com/abc",
};

function issuesOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues.join("\n");
  }
  throw new Error("expected ConfigError");
}

describe("loadConfig", () => {
  it("loads only the requested sections", () => {
    // A read-only CLI command needs just the database.
    expect(loadConfig(["db"], { DATABASE_URL: fullEnv.DATABASE_URL })).toEqual({
      DATABASE_URL: fullEnv.DATABASE_URL,
    });
  });

  it("coerces numbers and applies defaults", () => {
    const config = loadConfig(["db", "server", "credits"], fullEnv);
    expect(config.PORT).toBe(3000);
    expect(config.OPUSCLIP_DAILY_CREDIT_BUDGET).toBe(120);
  });

  it("names every missing variable across sections at once", () => {
    const issues = issuesOf(() => loadConfig(["db", "r2", "notify"], { DATABASE_URL: fullEnv.DATABASE_URL }));
    for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "NOTIFY_WEBHOOK_URL"]) {
      expect(issues).toContain(name);
    }
  });

  it("no longer requires LLM or OpusClip API keys", () => {
    expect(() => loadConfig(["db", "server", "credits", "r2", "notify"], fullEnv)).not.toThrow();
  });

  it("rejects a short reviewer token and a non-positive budget", () => {
    expect(issuesOf(() => loadConfig(["server"], { REVIEWER_TOKEN: "short" }))).toContain("REVIEWER_TOKEN");
    expect(issuesOf(() => loadConfig(["credits"], { OPUSCLIP_DAILY_CREDIT_BUDGET: "0" }))).toContain(
      "OPUSCLIP_DAILY_CREDIT_BUDGET",
    );
  });

  it("rejects blank secrets without echoing values", () => {
    const message = issuesOf(() => loadConfig(["r2"], { ...fullEnv, R2_SECRET_ACCESS_KEY: "   " }));
    expect(message).toContain("R2_SECRET_ACCESS_KEY");
    expect(message).not.toContain("secret-value-do-not-leak");
  });
});
