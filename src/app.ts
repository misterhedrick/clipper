import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { registerReviewRoutes } from "./web/routes.js";
import type { BundleStore } from "./modules/packaging/index.js";

/** Without a reviewerToken the app serves only /health (no review pages). */
export type AppDeps = {
  db: Db;
  reviewerToken?: string;
  now?: () => Date;
  bundles?: BundleStore;
  /** Proxy hops to trust for the client IP (1 on Render). 0 = use the socket address. */
  trustProxyHops?: number;
};

export function buildApp({ db, reviewerToken, now, bundles, trustProxyHops = 0 }: AppDeps): FastifyInstance {
  // Behind Render's proxy every request comes from the proxy; trusting exactly one hop gives the
  // real client IP (for the sign-in throttle) without letting clients spoof it via X-Forwarded-For.
  const options: FastifyServerOptions = { logger: process.env.NODE_ENV !== "test" };
  if (trustProxyHops > 0) options.trustProxy = (_address: string, hop: number) => hop < trustProxyHops;
  const app = Fastify(options);

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

  if (reviewerToken) registerReviewRoutes(app, { db, reviewerToken, now, bundles });

  return app;
}
