import { describe, expect, it } from "vitest";
import { InvalidConfigError, validateCampaignConfig } from "../../../src/modules/campaign-config/index.js";
import { validConfig } from "../../helpers/config.js";

function issues(mutate: (c: Record<string, any>) => void) {
  const c = validConfig();
  mutate(c);
  try {
    validateCampaignConfig(c);
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidConfigError);
    return (e as InvalidConfigError).issues;
  }
  throw new Error("expected the config to be rejected");
}

describe("validateCampaignConfig", () => {
  it("accepts a complete config and normalizes it", () => {
    const c = validConfig();
    c.requirements.requiredCaptionLines = ["  Pre-order today  "];
    delete c.requirements.requiredOnScreenText; // lists default to []
    const out = validateCampaignConfig(c);
    expect(out.requirements.requiredCaptionLines).toEqual(["Pre-order today"]);
    expect(out.requirements.requiredOnScreenText).toEqual([]);
  });

  it("rejects autoApprove: true (and any non-false value)", () => {
    for (const v of [true, "false", 0, null]) {
      expect(issues((c) => (c.review.autoApprove = v))).toContainEqual({
        path: "review.autoApprove",
        message: expect.stringContaining("must be false"),
      });
    }
  });

  it("reports field-level issues, all at once", () => {
    const found = issues((c) => {
      c.clipGeneration.aspectRatio = "vertical";
      c.clipGeneration.maxDurationSeconds = 900;
      c.requirements.requiredTags = ["callofduty", "@two words"];
      c.requirements.requiredCaptionLines = ["   "];
      c.requirements.maxAdditionalHashtags = -1;
    }).map((i) => i.path);
    expect(found).toEqual(
      expect.arrayContaining([
        "clipGeneration.aspectRatio",
        "clipGeneration.maxDurationSeconds",
        "requirements.requiredTags.0",
        "requirements.requiredTags.1",
        "requirements.requiredCaptionLines.0",
        "requirements.maxAdditionalHashtags",
      ]),
    );
  });

  it("rejects unknown (e.g. misspelled) keys instead of dropping them", () => {
    expect(issues((c) => (c.clipGeneration.minDurationSecs = 10))).toContainEqual({
      path: "clipGeneration",
      message: expect.stringContaining("minDurationSecs"),
    });
    expect(issues((c) => (c.extras = {}))).toContainEqual(expect.objectContaining({ path: "(root)" }));
  });

  it("refuses campaigns that require a logo, watermark or overlay", () => {
    expect(issues((c) => (c.requirements.requiredOverlayAssetIds = ["brand-logo.png"]))).toContainEqual({
      path: "requirements.requiredOverlayAssetIds",
      message: expect.stringContaining("aren't taken on"),
    });
  });

  it("requires min duration ≤ max duration", () => {
    expect(
      issues((c) => {
        c.clipGeneration.minDurationSeconds = 90;
        c.clipGeneration.maxDurationSeconds = 60;
      }),
    ).toContainEqual({ path: "clipGeneration.minDurationSeconds", message: "must not exceed maxDurationSeconds" });
  });

  it("requires a confidence (or unresolved listing) for every field, and only known fields", () => {
    expect(issues((c) => delete c.extraction.fieldConfidence["requirements.requiredTags"])).toContainEqual({
      path: "extraction.fieldConfidence",
      message: expect.stringContaining("requirements.requiredTags"),
    });
    expect(issues((c) => (c.extraction.fieldConfidence["requirements.hashtagz"] = "high"))).toContainEqual(
      expect.objectContaining({ path: "extraction.fieldConfidence", message: expect.stringContaining("requirements.hashtagz") }),
    );
    expect(issues((c) => (c.extraction.unresolvedFields = ["nope"]))[0]!.path).toBe("extraction.unresolvedFields.0");
  });
});
