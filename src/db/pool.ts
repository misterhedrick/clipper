import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

export type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * Runs `fn` inside a single transaction. Every module that needs to write a
 * status transition and its status_events row together (see DATA_MODEL.md —
 * "Application code should never update a status column without also
 * inserting here in the same transaction") should go through this.
 */
export async function withTransaction<T>(fn: (client: QueryClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
