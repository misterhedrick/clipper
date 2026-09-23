import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { registerReviewRoutes } from "./web/routes.js";

/** Without a reviewerToken the app serves only /health (no review pages). */
export type AppDeps = { db: Db; reviewerToken?: string; now?: () => Date };

export function buildApp({ db, reviewerToken, now }: AppDeps): FastifyInstance {
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

  if (reviewerToken) registerReviewRoutes(app, { db, reviewerToken, now });

  return app;
}
