import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { campaigns, sourceJobs, candidateClips } from "./schema.js";

/** Load a source job with its campaign. Used by submissions, candidates, review modules. */
export async function loadJobWithCampaign(db: Pick<Db, "select">, jobId: string) {
  const [row] = await db
    .select({ job: sourceJobs, campaign: campaigns })
    .from(sourceJobs)
    .innerJoin(campaigns, eq(campaigns.id, sourceJobs.campaignId))
    .where(eq(sourceJobs.id, jobId));
  return row;
}

/** Load a candidate clip with its job and campaign. Used by candidates and review modules. */
export async function loadCandidateWithContext(db: Pick<Db, "select">, id: string) {
  const [row] = await db
    .select({ clip: candidateClips, job: sourceJobs, campaign: campaigns })
    .from(candidateClips)
    .innerJoin(sourceJobs, eq(sourceJobs.id, candidateClips.sourceJobId))
    .innerJoin(campaigns, eq(campaigns.id, sourceJobs.campaignId))
    .where(eq(candidateClips.id, id));
  return row;
}
