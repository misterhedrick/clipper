import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config.js";
import type { CampaignConfig } from "../../db/types.js";

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const MODEL = "claude-sonnet-5";

/**
 * The fields we ask Claude to fill in. Kept separate from CampaignConfig
 * because the extractor never sets `review.autoApprove` (hard-coded false
 * always, see confirmCampaignConfig()) and needs the confidence/unresolved
 * bookkeeping as tool input, not as part of the stored config shape.
 */
const EXTRACTION_TOOL = {
  name: "record_campaign_requirements",
  description:
    "Records structured campaign requirements extracted from a Content Rewards campaign guideline document.",
  input_schema: {
    type: "object" as const,
    properties: {
      clipGeneration: {
        type: "object",
        properties: {
          aspectRatio: { type: "string", enum: ["portrait", "landscape", "square"] },
          minDurationSeconds: { type: "number" },
          maxDurationSeconds: { type: "number" },
          originalAudioOnly: { type: "boolean" },
          captionsEnabled: { type: "boolean" },
        },
        required: ["aspectRatio", "minDurationSeconds", "maxDurationSeconds", "originalAudioOnly", "captionsEnabled"],
      },
      requirements: {
        type: "object",
        properties: {
          requiredOverlayAssetIds: { type: "array", items: { type: "string" } },
          requiredOnScreenText: { type: "array", items: { type: "string" } },
          requiredCaptionLines: { type: "array", items: { type: "string" } },
          requiredTags: { type: "array", items: { type: "string" } },
          disclosureLines: { type: "array", items: { type: "string" } },
          maxAdditionalHashtags: { type: "number" },
        },
        required: [
          "requiredOverlayAssetIds",
          "requiredOnScreenText",
          "requiredCaptionLines",
          "requiredTags",
          "disclosureLines",
          "maxAdditionalHashtags",
        ],
      },
      fieldConfidence: {
        type: "object",
        description:
          "Confidence per top-level field above ('clipGeneration.aspectRatio', 'requirements.requiredTags', etc), 'high' or 'low'.",
        additionalProperties: { type: "string", enum: ["high", "low"] },
      },
      unresolvedFields: {
        type: "array",
        items: { type: "string" },
        description: "Field paths the document simply did not address at all.",
      },
    },
    required: ["clipGeneration", "requirements", "fieldConfidence", "unresolvedFields"],
  },
};

const SYSTEM_PROMPT = `You extract structured content requirements from creator-campaign guideline documents.

Rules:
- Only extract what the document actually states. Never invent a value.
- If the document doesn't address a field, still include it in the output using a reasonable placeholder (0 for numbers, [] for arrays, false for booleans) AND list its path in unresolvedFields.
- Mark fieldConfidence "low" for anything inferred or ambiguous, "high" only when the document states it plainly and unambiguously.
- requiredOnScreenText / requiredCaptionLines / disclosureLines should capture exact required wording verbatim, not paraphrased.
- Do not evaluate whether the campaign is a good idea, or add any commentary — only extract.`;

export interface ExtractionResult {
  clipGeneration: CampaignConfig["clipGeneration"];
  requirements: CampaignConfig["requirements"];
  fieldConfidence: Record<string, "high" | "low">;
  unresolvedFields: string[];
}

export class RequirementsExtractionError extends Error {}

/**
 * One Claude API call with a forced tool call, per docs/BUILD_PLAN.md task 4.
 * Never invented values without flagging them — this output is always a
 * draft (campaigns.status = pending_confirmation) until a human confirms it
 * via the confirm endpoint (see src/modules/review-api).
 */
export async function extractRequirements(guidelineDocText: string): Promise<ExtractionResult> {
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: EXTRACTION_TOOL.name },
    messages: [
      {
        role: "user",
        content: `Extract campaign requirements from this guideline document:\n\n${guidelineDocText}`,
      },
    ],
  });

  const toolUse = message.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new RequirementsExtractionError("Claude did not return a tool_use block for record_campaign_requirements");
  }

  return toolUse.input as ExtractionResult;
}

export function buildDraftCampaignConfig(extraction: ExtractionResult): CampaignConfig {
  return {
    clipGeneration: extraction.clipGeneration,
    requirements: extraction.requirements,
    review: {
      requiredChecks: ["visual_quality", "campaign_branding", "caption_compliance"],
      autoApprove: false,
    },
    extraction: {
      fieldConfidence: extraction.fieldConfidence,
      unresolvedFields: extraction.unresolvedFields,
    },
  };
}
