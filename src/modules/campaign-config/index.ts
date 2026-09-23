import { z } from "zod";

// The structured campaign config Claude drafts from a brief and a person confirms.
// Strict: unknown keys are errors, so a misspelled field can't be silently dropped.

const text = z.string().trim().min(1);
const textList = z.array(text).default([]);

export const clipGenerationSchema = z.strictObject({
  brandTemplateId: text.optional(),
  aspectRatio: z.enum(["portrait", "landscape", "square", "four_five"]),
  minDurationSeconds: z.number().int().min(1),
  // OpusClip accepts clip-duration buckets up to 600s.
  maxDurationSeconds: z.number().int().max(600),
  originalAudioOnly: z.boolean(),
  captionsEnabled: z.boolean(),
});

export const requirementsSchema = z.strictObject({
  requiredOverlayAssetIds: textList,
  requiredOnScreenText: textList,
  /** Exact phrases every caption must contain (checked verbatim). */
  requiredCaptionLines: textList,
  /** Accounts to tag, with the @. */
  requiredTags: z.array(text.regex(/^@\S+$/, "tags start with @ and contain no spaces")).default([]),
  disclosureLines: textList,
  maxAdditionalHashtags: z.number().int().min(0),
});

export const CONFIG_FIELDS = [
  ...Object.keys(clipGenerationSchema.shape).map((k) => `clipGeneration.${k}`),
  ...Object.keys(requirementsSchema.shape).map((k) => `requirements.${k}`),
] as const;

const fieldPath = z.enum(CONFIG_FIELDS as unknown as [string, ...string[]], {
  error: (issue) => `unknown field "${String(issue.input)}"; expected one of ${CONFIG_FIELDS.join(", ")}`,
});

export const campaignConfigSchema = z
  .strictObject({
    clipGeneration: clipGenerationSchema,
    requirements: requirementsSchema,
    review: z.strictObject({
      requiredChecks: textList,
      // Hard invariant (README non-goals): clips are never auto-approved in v1.
      autoApprove: z.literal(false, { error: "autoApprove must be false: clips always need a person's approval" }),
    }),
    extraction: z.strictObject({
      /** Per field: "high" only if the brief states it explicitly; inferred or defaulted values are "low". */
      fieldConfidence: z.partialRecord(fieldPath, z.enum(["high", "low"])),
      /** Fields the brief doesn't cover at all. */
      unresolvedFields: z.array(fieldPath).default([]),
      /** Brief rules the config can't express (dedicated page, audience tier, content filters, …), for the reviewer. */
      unexpressedRules: textList,
    }),
  })
  .superRefine((c, ctx) => {
    if (c.clipGeneration.minDurationSeconds > c.clipGeneration.maxDurationSeconds) {
      ctx.addIssue({
        code: "custom",
        path: ["clipGeneration", "minDurationSeconds"],
        message: "must not exceed maxDurationSeconds",
      });
    }
    const missing = CONFIG_FIELDS.filter((f) => !(f in c.extraction.fieldConfidence) && !c.extraction.unresolvedFields.includes(f));
    if (missing.length) {
      ctx.addIssue({
        code: "custom",
        path: ["extraction", "fieldConfidence"],
        message: `every field needs a confidence or must be listed in unresolvedFields; missing: ${missing.join(", ")}`,
      });
    }
  });

export type CampaignConfig = z.infer<typeof campaignConfigSchema>;

export type ConfigIssue = { path: string; message: string };

export class InvalidConfigError extends Error {
  readonly code = "invalid_config";
  constructor(public readonly issues: ConfigIssue[]) {
    super(`Campaign config is invalid (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "InvalidConfigError";
  }
}

/** Validates a proposed config, returning it normalized (defaults applied, strings trimmed) or throwing field-level issues. */
export function validateCampaignConfig(input: unknown): CampaignConfig {
  const result = campaignConfigSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidConfigError(
      result.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message })),
    );
  }
  return result.data;
}
