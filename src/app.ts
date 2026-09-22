import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.js";

export type AppDeps = { db: Db };

export function buildApp({ db }: AppDeps): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  // Render's healthCheckPath: 200 only once the database is actually reachable.
  app.get("/health", async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: "ok" };
    } catch (err) {
      app.log.error({ err }, "health check: database unreachable");
      return reply.code(503).send({ status: "unavailable", reason: "database_unreachable" });
    }
  });

  return app;
}
