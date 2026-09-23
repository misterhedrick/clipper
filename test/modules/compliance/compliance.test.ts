import { describe, expect, it } from "vitest";
import { validateCampaignConfig, type CampaignConfig } from "../../../src/modules/campaign-config/index.js";
import { normalizeAspect, runObjectiveChecks, validateCaption } from "../../../src/modules/compliance/index.js";
import { validConfig } from "../../helpers/config.js";

const config = (mutate: (c: Record<string, any>) => void = () => {}): CampaignConfig => {
  const c = validConfig();
  mutate(c);
  return validateCampaignConfig(c);
};

const PHRASE = "Pre-order Modern Warfare 4 today and play day one, October 23rd";
const COMPLIANT = `This flank was disgusting 😳 @callofduty\n${PHRASE}\n#mw4 #cod\n#Ad`;

describe("objective checks", () => {
  it("passes a clip inside the duration bounds with the configured aspect ratio", () => {
    expect(runObjectiveChecks({ durationMs: 32_000, aspect: "9:16" }, config())).toMatchObject({
      duration: "pass",
      aspect_ratio: "pass",
    });
  });

  it("fails a wrong aspect ratio and an out-of-bounds duration", () => {
    const r = runObjectiveChecks({ durationMs: 9_000, aspect: "16:9" }, config());
    expect(r.duration).toBe("fail");
    expect(r.aspect_ratio).toBe("fail");
    expect(runObjectiveChecks({ durationMs: 61_000 }, config()).duration).toBe("fail");
  });

  it("never claims a pass it can't verify", () => {
    const r = runObjectiveChecks(
      {},
      config((c) => {
        c.requirements.requiredOverlayAssetIds = ["logo"];
        c.requirements.requiredOnScreenText = ["PRE-ORDER NOW"];
        c.review.requiredChecks = ["visual_quality", "caption_compliance"];
      }),
    );
    expect(r).toEqual({
      duration: "manual_review_required",
      aspect_ratio: "manual_review_required",
      required_overlay: "manual_review_required",
      required_on_screen_text: "manual_review_required",
      caption_compliance: "manual_review_required",
      visual_quality: "manual_review_required",
    });
  });

  it("reads aspect names, ratios and pixel sizes", () => {
    expect(normalizeAspect({ aspect: "portrait" })).toBe("portrait");
    expect(normalizeAspect({ aspect: "9x16" })).toBe("portrait");
    expect(normalizeAspect({ aspect: "4:5" })).toBe("four_five");
    expect(normalizeAspect({ width: 1080, height: 1920 })).toBe("portrait");
    expect(normalizeAspect({ width: 1080, height: 1350 })).toBe("four_five");
    expect(normalizeAspect({ width: 1080, height: 1080 })).toBe("square");
    expect(normalizeAspect({ aspect: "3:2" })).toBeUndefined();
    expect(normalizeAspect({ aspect: "fit" })).toBeUndefined();
  });
});

describe("validateCaption (MW4 rules)", () => {
  it("accepts a compliant caption", () => {
    expect(validateCaption(COMPLIANT, config())).toEqual({ valid: true, issues: [], additionalHashtags: ["mw4", "cod"] });
  });

  it("rejects each single omission with its own specific reason", () => {
    const cases: [string, string, string][] = [
      [COMPLIANT.replace(PHRASE, "Pre-order MW4 now"), "required_caption_line", `missing required phrase: "${PHRASE}"`],
      [COMPLIANT.replace(" @callofduty", ""), "required_tag", "missing required tag @callofduty"],
      [COMPLIANT.replace("\n#Ad", ""), "disclosure", 'missing disclosure "#Ad" (on its own line)'],
    ];
    for (const [caption, rule, message] of cases) {
      expect(validateCaption(caption, config())).toEqual({ valid: false, issues: [{ rule, message }], additionalHashtags: expect.any(Array) });
    }
  });

  it("requires the disclosure on a line of its own", () => {
    const inline = COMPLIANT.replace("#mw4 #cod\n#Ad", "#mw4 #cod #Ad");
    expect(validateCaption(inline, config()).issues).toEqual([{ rule: "disclosure", message: 'disclosure "#Ad" must be on a line of its own' }]);
  });

  it("says when the phrase is there but not verbatim", () => {
    const issues = validateCaption(COMPLIANT.replace(PHRASE, PHRASE.toLowerCase().replace(",", "")), config()).issues;
    expect(issues).toEqual([{ rule: "required_caption_line", message: expect.stringContaining("not verbatim") }]);
  });

  it("matches tags as whole handles, case-insensitively", () => {
    expect(validateCaption(COMPLIANT.replace("@callofduty", "@CallOfDuty."), config()).valid).toBe(true);
    expect(validateCaption(COMPLIANT.replace("@callofduty", "@callofdutyleaks"), config()).issues[0]?.rule).toBe("required_tag");
    expect(validateCaption(COMPLIANT.replace("@callofduty", "x@callofduty"), config()).issues[0]?.rule).toBe("required_tag");
  });

  it("limits additional hashtags, not counting ones inside required lines or disclosures", () => {
    const four = COMPLIANT.replace("#mw4 #cod", "#mw4 #cod #fps #gaming");
    expect(validateCaption(four, config()).issues).toEqual([
      { rule: "hashtag_limit", message: "4 additional hashtags (#mw4 #cod #fps #gaming); the campaign allows at most 3" },
    ]);
    // #Ad is the disclosure, so it's not "additional"; repeats count once.
    expect(validateCaption(COMPLIANT.replace("#mw4 #cod", "#mw4 #MW4 #cod #fps"), config()).valid).toBe(true);
  });

  it("rejects an empty caption", () => {
    expect(validateCaption("  \n ", config()).issues).toEqual([{ rule: "empty", message: "caption is empty" }]);
  });
});
