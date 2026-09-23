import { CONFIG_FIELDS } from "../../src/modules/campaign-config/index.js";

/** A complete, valid campaign config (MW4-style rules). Tests override what they need. */
export function validConfig(): Record<string, any> {
  return {
    clipGeneration: {
      aspectRatio: "portrait",
      minDurationSeconds: 15,
      maxDurationSeconds: 60,
      originalAudioOnly: false,
      captionsEnabled: true,
    },
    requirements: {
      requiredOverlayAssetIds: [],
      requiredOnScreenText: [],
      requiredCaptionLines: ["Pre-order Modern Warfare 4 today and play day one, October 23rd"],
      requiredTags: ["@callofduty"],
      disclosureLines: ["#Ad"],
      maxAdditionalHashtags: 3,
    },
    review: { requiredChecks: ["caption_compliance"], autoApprove: false },
    extraction: {
      fieldConfidence: Object.fromEntries(
        CONFIG_FIELDS.filter((f) => f !== "clipGeneration.brandTemplateId").map((f) => [f, "high"]),
      ),
      unresolvedFields: ["clipGeneration.brandTemplateId"],
      unexpressedRules: ["Clips must be edited, not posted as a raw reel"],
    },
  };
}
