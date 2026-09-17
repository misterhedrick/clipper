import { describe, expect, it } from "vitest";
import { runComplianceChecks } from "../../../src/modules/compliance-service/index.js";
import type { CampaignConfig, CandidateClip } from "../../../src/db/types.js";

function baseConfig(overrides: Partial<CampaignConfig> = {}): CampaignConfig {
  return {
    clipGeneration: {
      aspectRatio: "portrait",
      minDurationSeconds: 10,
      maxDurationSeconds: 45,
      originalAudioOnly: true,
      captionsEnabled: false,
    },
    requirements: {
      requiredOverlayAssetIds: [],
      requiredOnScreenText: [],
      requiredCaptionLines: [],
      requiredTags: [],
      disclosureLines: [],
      maxAdditionalHashtags: 3,
    },
    review: { requiredChecks: [], autoApprove: false },
    extraction: { fieldConfidence: {}, unresolvedFields: [] },
    ...overrides,
  };
}

function baseClip(overrides: Partial<CandidateClip> = {}): CandidateClip {
  return {
    id: "clip-1",
    created_at: new Date(),
    updated_at: new Date(),
    source_job_id: "job-1",
    opusclip_clip_id: "proj.curation",
    title: null,
    duration_ms: 30000,
    preview_url: "https://example.com/preview.mp4",
    export_url: "https://example.com/export.mp4",
    hashtags: null,
    status: "generated",
    check_results: {},
    ...overrides,
  };
}

describe("runComplianceChecks", () => {
  it("passes duration within bounds", () => {
    const results = runComplianceChecks(baseClip({ duration_ms: 30000 }), baseConfig());
    expect(results.duration_bounds).toBe("pass");
  });

  it("fails duration outside bounds", () => {
    const results = runComplianceChecks(baseClip({ duration_ms: 5000 }), baseConfig());
    expect(results.duration_bounds).toBe("fail");
  });

  it("requires manual review when duration is unknown", () => {
    const results = runComplianceChecks(baseClip({ duration_ms: null }), baseConfig());
    expect(results.duration_bounds).toBe("manual_review_required");
  });

  it("never claims overlay compliance — always manual_review_required when configured", () => {
    const config = baseConfig({
      requirements: {
        requiredOverlayAssetIds: ["logo-1"],
        requiredOnScreenText: [],
        requiredCaptionLines: [],
        requiredTags: [],
        disclosureLines: [],
        maxAdditionalHashtags: 3,
      },
    });
    const results = runComplianceChecks(baseClip(), config);
    expect(results.required_overlay_present).toBe("manual_review_required");
  });

  it("does not add an overlay check when the campaign doesn't require one", () => {
    const results = runComplianceChecks(baseClip(), baseConfig());
    expect(results.required_overlay_present).toBeUndefined();
  });

  it("passes caption line check when required text is present in title/hashtags", () => {
    const config = baseConfig({
      requirements: {
        requiredOverlayAssetIds: [],
        requiredOnScreenText: [],
        requiredCaptionLines: ["#ad"],
        requiredTags: [],
        disclosureLines: [],
        maxAdditionalHashtags: 3,
      },
    });
    const results = runComplianceChecks(baseClip({ hashtags: "#ad #gaming" }), config);
    expect(results.required_caption_lines_present).toBe("pass");
  });

  it("never claims caption-line failure with certainty — manual_review_required instead", () => {
    const config = baseConfig({
      requirements: {
        requiredOverlayAssetIds: [],
        requiredOnScreenText: [],
        requiredCaptionLines: ["#ad"],
        requiredTags: [],
        disclosureLines: [],
        maxAdditionalHashtags: 3,
      },
    });
    const results = runComplianceChecks(baseClip({ hashtags: "#gaming" }), config);
    expect(results.required_caption_lines_present).toBe("manual_review_required");
  });

  it("flags export_succeeded as manual_review_required when no export url yet", () => {
    const results = runComplianceChecks(baseClip({ export_url: null }), baseConfig());
    expect(results.export_succeeded).toBe("manual_review_required");
  });
});
