import PgBoss from "pg-boss";
import { config } from "../config.js";

/**
 * Queue names — see ARCHITECTURE.md § job-queue. One pg-boss instance,
 * shared by the API process (which only ever sends) and the worker process
 * (which sends and consumes). Both connect to the same Postgres database as
 * the tracker, per ARCHITECTURE.md's reasoning for choosing pg-boss.
 */
export const QUEUES = {
  ENUMERATE_FOOTAGE: "enumerate-footage",
  VALIDATE_SOURCE: "validate-source",
  CREATE_PROJECT: "create-project",
  POLL_PROJECT: "poll-project",
  RUN_CHECKS: "run-checks",
  EXPORT_CLIP: "export-clip",
} as const;

let bossInstance: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  const boss = new PgBoss({ connectionString: config.DATABASE_URL });
  boss.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("pg-boss error:", err);
  });
  await boss.start();
  for (const queueName of Object.values(QUEUES)) {
    await boss.createQueue(queueName);
  }
  bossInstance = boss;
  return boss;
}

export interface EnumerateFootageJob {
  campaignId: string;
}
export interface ValidateSourceJob {
  sourceJobId: string;
}
export interface PollProjectJob {
  sourceJobId: string;
}
export interface ExportClipJob {
  candidateClipId: string;
}
