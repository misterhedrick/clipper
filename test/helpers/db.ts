import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { sql } from "drizzle-orm";
import { runMigrations } from "../../src/db/migrate.js";
import type { Db } from "../../src/db/client.js";

loadDotenv({ quiet: true });

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Drops everything in the test database and re-applies all migrations from scratch, in order. */
export async function resetTestDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("drop schema if exists public cascade");
    await client.query("drop schema if exists drizzle cascade");
    await client.query("create schema public");
  } finally {
    await client.end();
  }
  await runMigrations(url);
}

export async function truncateAll(db: Db): Promise<void> {
  await db.execute(
    sql`truncate posts, credit_ledger, opus_usage_snapshots, candidate_clips, source_jobs, footage_sources, status_events, campaigns restart identity cascade`,
  );
}
