import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const validEnv = {
  DATABASE_URL: "postgres://u:p@localhost:5432/clipper",
  OPUSCLIP_API_KEY: "opus-key",
  GOOGLE_API_KEY: "google-key",
  ANTHROPIC_API_KEY: "anthropic-key",
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "access",
  R2_SECRET_ACCESS_KEY: "secret-value-do-not-leak",
  R2_BUCKET_NAME: "bucket",
  NOTIFY_WEBHOOK_URL: "https://hooks.example.com/abc",
};

describe("loadConfig", () => {
  it("accepts a complete environment and defaults PORT", () => {
    const config = loadConfig(validEnv);
    expect(config.PORT).toBe(3000);
    expect(config.R2_BUCKET_NAME).toBe("bucket");
  });

  it("fails naming every missing variable at once", () => {
    const { OPUSCLIP_API_KEY: _a, R2_BUCKET_NAME: _b, ...partial } = validEnv;
    let error: unknown;
    try {
      loadConfig(partial);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const issues = (error as ConfigError).issues.join("\n");
    expect(issues).toContain("OPUSCLIP_API_KEY");
    expect(issues).toContain("R2_BUCKET_NAME");
  });

  it("rejects blank secrets", () => {
    expect(() => loadConfig({ ...validEnv, ANTHROPIC_API_KEY: "   " })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("rejects a malformed DATABASE_URL without echoing secret values", () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: "not a url" })).toThrow(/DATABASE_URL/);
    try {
      loadConfig({ ...validEnv, NOTIFY_WEBHOOK_URL: "nope" });
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-value-do-not-leak");
    }
  });
});
