import { z } from "zod";

/**
 * Runtime mirror of db/types.ts's CampaignConfig. This is the one real
 * system boundary that accepts a human-submitted config wholesale (the
 * confirm endpoint) — validate it properly here rather than trusting
 * z.record(z.unknown()) and a type cast, per the project's own "only
 * validate at system boundaries" principle.
 */
export const campaignConfigSchema = z.object({
  clipGeneration: z.object({
    brandTemplateId: z.string().optional(),
    aspectRatio: z.enum(["portrait", "landscape", "square"]),
    minDurationSeconds: z.number().nonnegative(),
    maxDurationSeconds: z.number().positive(),
    originalAudioOnly: z.boolean(),
    captionsEnabled: z.boolean(),
  }),
  requirements: z.object({
    requiredOverlayAssetIds: z.array(z.string()),
    requiredOnScreenText: z.array(z.string()),
    requiredCaptionLines: z.array(z.string()),
    requiredTags: z.array(z.string()),
    disclosureLines: z.array(z.string()),
    maxAdditionalHashtags: z.number().int().nonnegative(),
  }),
  review: z.object({
    requiredChecks: z.array(z.string()),
    autoApprove: z.literal(false),
  }),
  extraction: z.object({
    fieldConfidence: z.record(z.enum(["high", "low"])),
    unresolvedFields: z.array(z.string()),
  }),
});
