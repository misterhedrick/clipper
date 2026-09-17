import Fastify from "fastify";
import { ZodError } from "zod";
import { pool } from "./db/pool.js";
import { findSourceJobByOpusClipProjectId } from "./db/repositories/sourceJobs.js";
import { pollProjectClips } from "./modules/project-monitor/index.js";
import { registerReviewApiRoutes } from "./modules/review-api/routes.js";

export function buildServer() {
  const app = Fastify({ logger: true });

  // A schema.parse() throw inside a route (e.g. an invalid campaign config
  // submitted to /campaigns/:id/confirm) is a client error, not a server
  // fault — without this handler Fastify's default maps it to a bare 500.
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "validation_failed", issues: error.issues });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get("/health", async (_req, reply) => {
    try {
      await pool.query("select 1");
      return reply.code(200).send({ status: "ok" });
    } catch (err) {
      return reply.code(503).send({ status: "db_unreachable", error: err instanceof Error ? err.message : String(err) });
    }
  });

  // OpusClip webhook receiver — per docs/API_CONTRACTS.md, the payload shape
  // isn't fully documented, so this never trusts fields in the body beyond
  // finding a project id to poll. Polling (project-monitor) stays the real
  // source of truth; this just triggers it early for lower latency.
  app.post("/webhooks/opusclip", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const projectId =
      (body.projectId as string | undefined) ??
      (body.id as string | undefined) ??
      ((body.data as Record<string, unknown> | undefined)?.projectId as string | undefined);

    if (!projectId) {
      req.log.warn({ body }, "opusclip webhook payload had no recognizable project id — ignoring, polling will still catch it");
      return reply.code(200).send({ received: true, matched: false });
    }

    const sourceJob = await findSourceJobByOpusClipProjectId(projectId);
    if (!sourceJob) {
      req.log.warn({ projectId }, "opusclip webhook referenced an unknown project id");
      return reply.code(200).send({ received: true, matched: false });
    }

    await pollProjectClips(sourceJob);
    return reply.code(200).send({ received: true, matched: true });
  });

  app.register(registerReviewApiRoutes);

  return app;
}
