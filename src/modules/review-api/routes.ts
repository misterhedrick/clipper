import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  confirmCampaignConfig,
  createCampaign,
  findCampaignByContentRewardsId,
  findCampaignById,
  setCampaignDraftConfig,
  setCampaignMetadata,
} from "../../db/repositories/campaigns.js";
import { findCandidateClipsByStatus, findCandidateClipById, transitionCandidateClipStatus } from "../../db/repositories/candidateClips.js";
import type { CandidateClipStatus } from "../../db/types.js";
import { fetchCampaignMetadata, resolveCampaignId } from "../../modules/campaign-connector/index.js";
import { detectFootageSourceInDocText, fetchGuidelineDocText } from "../../modules/requirements-extractor/fetchGuidelineDoc.js";
import { buildDraftCampaignConfig, extractRequirements } from "../../modules/requirements-extractor/index.js";
import { notifyNeedsAttention } from "../../modules/notifier/index.js";
import { QUEUES, getBoss } from "../../queue/index.js";
import { campaignConfigSchema } from "./campaignConfigSchema.js";

const registerCampaignSchema = z.object({ contentRewardsUrl: z.string().min(1) });
const confirmCampaignSchema = z.object({
  config: campaignConfigSchema,
  confirmedBy: z.string().min(1),
});
const decisionSchema = z.object({
  decision: z.enum(["approve", "needs_edit", "reject", "hold"]),
  reviewer: z.string().min(1),
  notes: z.string().optional(),
});

const DECISION_TO_STATUS: Record<string, CandidateClipStatus> = {
  approve: "approved",
  needs_edit: "needs_edit",
  reject: "rejected",
  hold: "generated", // stays out of the review queue's "awaiting_review" filter without a terminal status
};

export async function registerReviewApiRoutes(app: FastifyInstance): Promise<void> {
  // --- Campaign registration (BUILD_PLAN.md tasks 3-5) ---

  app.post("/campaigns", async (req, reply) => {
    const body = registerCampaignSchema.parse(req.body);

    let campaignId: string;
    try {
      campaignId = await resolveCampaignId(body.contentRewardsUrl);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }

    const existing = await findCampaignByContentRewardsId(campaignId);
    if (existing) return reply.code(200).send(existing);

    const campaign = await createCampaign({ contentRewardsCampaignId: campaignId, contentRewardsUrl: body.contentRewardsUrl });

    try {
      const metadata = await fetchCampaignMetadata(campaignId);
      const withMetadata = await setCampaignMetadata(campaign.id, {
        title: metadata.title,
        brand: metadata.brand,
        platforms: metadata.platforms,
        guidelineDocUrl: metadata.guidelineDocUrl,
        driveFolderUrl: metadata.driveFolderUrl,
        driveFolderId: metadata.driveFolderId,
      });

      if (!withMetadata.guideline_doc_url) {
        await notifyNeedsAttention("campaign", campaign.id, "No guideline doc found on the campaign page");
        return reply.code(201).send(withMetadata);
      }

      const docText = await fetchGuidelineDocText(withMetadata.guideline_doc_url);

      // Prefer a Drive folder from the campaign page; fall back to whatever
      // footage source link the guideline doc itself names — see
      // docs/API_CONTRACTS.md § "footage isn't always on Google Drive".
      if (!withMetadata.drive_folder_id) {
        const detected = detectFootageSourceInDocText(docText);
        if (detected?.sourceType === "google_drive") {
          const folderIdMatch = detected.url.match(/folders\/([a-zA-Z0-9_-]+)/);
          if (folderIdMatch) {
            await setCampaignMetadata(campaign.id, {
              title: withMetadata.title!,
              brand: withMetadata.brand,
              platforms: withMetadata.platforms,
              guidelineDocUrl: withMetadata.guideline_doc_url,
              driveFolderUrl: detected.url,
              driveFolderId: folderIdMatch[1],
            });
          }
        } else if (detected) {
          await notifyNeedsAttention(
            "campaign",
            campaign.id,
            `footage_source_not_supported: ${detected.sourceType} (${detected.url})`,
          );
        } else {
          await notifyNeedsAttention("campaign", campaign.id, "No recognizable footage source found on page or in guideline doc");
        }
      }

      const extraction = await extractRequirements(docText);
      const draftConfig = buildDraftCampaignConfig(extraction);
      const withDraft = await setCampaignDraftConfig(campaign.id, draftConfig);

      return reply.code(201).send(withDraft);
    } catch (err) {
      // Any failure past this point (unreachable doc, Content Rewards markup
      // change, a Claude API error) must land the campaign in a visible,
      // alerted state — never a bare 500 with the campaign silently stuck
      // in "ingesting". See README § "no silent failures".
      const message = err instanceof Error ? err.message : String(err);
      await notifyNeedsAttention("campaign", campaign.id, message);
      req.log.error({ err, campaignId: campaign.id }, "campaign registration failed after creation");
      // Re-fetch rather than returning the stale pre-metadata `campaign`
      // variable — title/brand/platforms/guideline_doc_url may well have
      // been persisted successfully before the step that actually failed.
      const latest = await findCampaignById(campaign.id);
      return reply.code(201).send({ ...(latest ?? campaign), error: message });
    }
  });

  app.get("/campaigns/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const campaign = await findCampaignById(id);
    if (!campaign) return reply.code(404).send({ error: "not found" });
    return campaign;
  });

  app.post("/campaigns/:id/confirm", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = confirmCampaignSchema.parse(req.body);
    try {
      const campaign = await confirmCampaignConfig(id, body.config, body.confirmedBy);
      return campaign;
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Candidate review queue (BUILD_PLAN.md task 11) ---

  app.get("/candidates", async (req) => {
    const { status } = req.query as { status?: CandidateClipStatus };
    return findCandidateClipsByStatus(status ?? "awaiting_review");
  });

  app.post("/candidates/:id/decision", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = decisionSchema.parse(req.body);
    const clip = await findCandidateClipById(id);
    if (!clip) return reply.code(404).send({ error: "not found" });

    const toStatus = DECISION_TO_STATUS[body.decision];
    const updated = await transitionCandidateClipStatus(id, toStatus, body.reviewer, body.notes);

    if (body.decision === "approve") {
      const boss = await getBoss();
      await boss.send(QUEUES.EXPORT_CLIP, { candidateClipId: id });
    }

    return updated;
  });
}
