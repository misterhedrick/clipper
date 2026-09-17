import type { QueryClient } from "../pool.js";
import { pool, withTransaction } from "../pool.js";
import { recordStatusEvent } from "../statusEvents.js";
import type { Campaign, CampaignConfig, CampaignStatus } from "../types.js";

function mapRow(row: any): Campaign {
  return { ...row, config: row.config ?? {} };
}

export async function findCampaignByContentRewardsId(contentRewardsCampaignId: string): Promise<Campaign | null> {
  const { rows } = await pool.query(
    `select * from campaigns where content_rewards_campaign_id = $1`,
    [contentRewardsCampaignId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function findCampaignById(id: string): Promise<Campaign | null> {
  const { rows } = await pool.query(`select * from campaigns where id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function listActiveCampaigns(): Promise<Campaign[]> {
  const { rows } = await pool.query(`select * from campaigns where status = 'active'`);
  return rows.map(mapRow);
}

export interface CreateCampaignInput {
  contentRewardsCampaignId: string;
  contentRewardsUrl: string;
}

/** Inserts a campaign in `discovered` status. campaign-connector fills in metadata next. */
export async function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into campaigns (content_rewards_campaign_id, content_rewards_url, status)
       values ($1, $2, 'discovered') returning *`,
      [input.contentRewardsCampaignId, input.contentRewardsUrl],
    );
    const campaign = mapRow(rows[0]);
    await recordStatusEvent(client, {
      entityType: "campaign",
      entityId: campaign.id,
      fromStatus: null,
      toStatus: "discovered",
      actor: "system",
      reason: "Campaign registered from Content Rewards URL",
    });
    return campaign;
  });
}

export interface CampaignMetadata {
  title: string;
  brand: string | null;
  platforms: string[];
  guidelineDocUrl: string | null;
  driveFolderUrl: string | null;
  driveFolderId: string | null;
}

export async function setCampaignMetadata(
  id: string,
  metadata: CampaignMetadata,
  actor = "system",
): Promise<Campaign> {
  return withTransaction(async (client) => {
    const current = await client.query(`select status from campaigns where id = $1`, [id]);
    const fromStatus = current.rows[0]?.status ?? null;
    const { rows } = await client.query(
      `update campaigns set
         title = $2, brand = $3, platforms = $4,
         guideline_doc_url = $5, drive_folder_url = $6, drive_folder_id = $7,
         status = 'ingesting', updated_at = now()
       where id = $1 returning *`,
      [
        id,
        metadata.title,
        metadata.brand,
        metadata.platforms,
        metadata.guidelineDocUrl,
        metadata.driveFolderUrl,
        metadata.driveFolderId,
      ],
    );
    await recordStatusEvent(client, {
      entityType: "campaign",
      entityId: id,
      fromStatus,
      toStatus: "ingesting",
      actor,
      reason: "Campaign metadata, guideline doc, and drive folder resolved",
    });
    return mapRow(rows[0]);
  });
}

export async function setCampaignDraftConfig(
  id: string,
  config: CampaignConfig,
  actor = "system",
): Promise<Campaign> {
  return transitionCampaignStatus(id, "pending_confirmation", actor, "Requirements extracted, awaiting human confirmation", config);
}

export async function confirmCampaignConfig(
  id: string,
  config: CampaignConfig,
  confirmedBy: string,
): Promise<Campaign> {
  if (config.review.autoApprove !== false) {
    throw new Error("review.autoApprove must be false — auto-approval is not permitted in v1");
  }
  return withTransaction(async (client) => {
    const current = await client.query(`select status from campaigns where id = $1`, [id]);
    const fromStatus = current.rows[0]?.status ?? null;
    const { rows } = await client.query(
      `update campaigns set
         config = $2, status = 'active',
         config_confirmed_at = now(), config_confirmed_by = $3,
         updated_at = now()
       where id = $1 returning *`,
      [id, JSON.stringify(config), confirmedBy],
    );
    await recordStatusEvent(client, {
      entityType: "campaign",
      entityId: id,
      fromStatus,
      toStatus: "active",
      actor: confirmedBy,
      reason: "Requirements confirmed by human reviewer",
    });
    return mapRow(rows[0]);
  });
}

export async function transitionCampaignStatus(
  id: string,
  toStatus: CampaignStatus,
  actor: string,
  reason?: string,
  config?: CampaignConfig,
): Promise<Campaign> {
  return withTransaction(async (client) => {
    const current = await client.query(`select status from campaigns where id = $1`, [id]);
    const fromStatus = current.rows[0]?.status ?? null;
    const { rows } = config
      ? await client.query(
          `update campaigns set status = $2, config = $3, updated_at = now() where id = $1 returning *`,
          [id, toStatus, JSON.stringify(config)],
        )
      : await client.query(`update campaigns set status = $2, updated_at = now() where id = $1 returning *`, [
          id,
          toStatus,
        ]);
    await recordStatusEvent(client, { entityType: "campaign", entityId: id, fromStatus, toStatus, actor, reason });
    return mapRow(rows[0]);
  });
}

export { withTransaction as withCampaignTransaction };
export type { QueryClient };
