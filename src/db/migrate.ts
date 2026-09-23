import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

loadDotenv({ quiet: true });

// Resolved from the repo root so it works from both src/ (tsx) and dist/ (node).
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../src/db/migrations", import.meta.url));

export async function runMigrations(databaseUrl: string): Promise<void> {
  const { db, pool } = createDb(databaseUrl);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

// Only DATABASE_URL is needed to migrate (Render's pre-deploy step), so this
// deliberately doesn't go through loadConfig() and its full secret list.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required to run migrations");
    process.exit(1);
  }
  await runMigrations(url);
  console.log("Migrations applied");
}
