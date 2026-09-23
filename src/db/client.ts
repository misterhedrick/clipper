import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

/**
 * Pool options for a connection string. When DATABASE_CA_CERT holds a PEM
 * certificate (e.g. Supabase's root CA, which Node doesn't trust by default),
 * TLS is required and the server is verified against it. pg lets `sslmode` &
 * co. in the URL override an explicit `ssl` option, so those are removed first.
 */
export function poolConfig(databaseUrl: string, caCert = process.env.DATABASE_CA_CERT): pg.PoolConfig {
  const ca = caCert?.trim().replace(/\\n/g, "\n");
  if (!ca) return { connectionString: databaseUrl };
  if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error("DATABASE_CA_CERT must be a PEM certificate (-----BEGIN CERTIFICATE----- …)");
  const url = new URL(databaseUrl);
  for (const p of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) url.searchParams.delete(p);
  return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true } };
}

export function createDb(databaseUrl: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool(poolConfig(databaseUrl));
  return { db: drizzle(pool, { schema }), pool };
}
