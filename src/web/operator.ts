import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { run } from "../cli/run.js";
import type { Db } from "../db/client.js";
import type { BundleStore } from "../modules/packaging/index.js";
import { tokenMatches } from "./auth.js";

// The Claude operator's route to the database. Claude's cloud sessions can only
// make HTTPS requests, so the `clipper` CLI there (CLIPPER_REMOTE_URL, see
// src/cli/remote.ts) sends each command here, and it runs through the very same
// run() against this app's database.
//
// It changes nothing about who may do what: run() always acts as
// `claude-operator`, so the human-only rules in transition() and the review
// module refuse approvals exactly as they do locally. OPERATOR_TOKEN is a
// separate secret from REVIEWER_TOKEN: holding it lets you operate, never review.

const body = z.strictObject({
  argv: z.array(z.string().max(20_000)).min(1).max(64),
  stdin: z.string().max(4_000_000).optional(),
});

export type OperatorRouteOptions = { db: Db; operatorToken: string; env?: NodeJS.ProcessEnv; bundles?: BundleStore };

export function registerOperatorRoute(app: FastifyInstance, opts: OperatorRouteOptions) {
  app.post("/operator/run", { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token || !tokenMatches(token, opts.operatorToken)) {
      return reply.code(401).send({ error: { code: "remote_auth", message: "Missing or wrong operator token" } });
    }
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "usage", message: `Bad request: ${parsed.error.issues[0]?.message ?? "invalid body"}` } });
    }
    const { argv, stdin } = parsed.data;
    const started = Date.now();
    const result = await run(argv, {
      db: opts.db,
      env: opts.env ?? process.env,
      stdin: async () => stdin ?? "",
      remote: true,
      ...(opts.bundles ? { bundleStore: opts.bundles } : {}),
    });
    // Log which command ran, not its arguments or output (captions, URLs, notes).
    req.log.info({ command: argv.slice(0, 2).join(" "), exitCode: result.exitCode, ms: Date.now() - started }, "operator command");
    return result;
  });
}
