# Deployment (Render + Cloudflare R2)

This maps the architecture in `ARCHITECTURE.md` onto concrete hosting. Nothing here is deployed yet — this is the target to build toward once Phase 1 code exists.

## Services

Three Render resources for compute + database (plus the Claude operator, which runs as a Claude Code Routine, not on Render; see below), plus a Cloudflare R2 bucket for file storage:

| Resource | Where | Runs | Why |
|---|---|---|---|
| **Web Service** | Render | Fastify app: `review-api` HTTP routes + the OpusClip webhook receiver (`server.ts`) | Needs a public HTTPS URL — this is what `conclusionActions` in `API_CONTRACTS.md` points at, and what a human reviewer's browser hits. |
| **Cron Job** | Render | `clipper sync` every 10 minutes: poll OpusClip, upsert candidates, run checks, package approvals, send notifications | Deterministic and short-lived, so there's no need for a long-running worker. (Replaces the earlier pg-boss Background Worker; see `ARCHITECTURE.md`.) |
| **PostgreSQL** | Render | The `tracker` database from `DATA_MODEL.md`; status columns double as the work queue | A plain managed instance, not behind a transaction-mode pooler, so `SELECT … FOR UPDATE` credit reservations behave normally. Database and compute share one platform and bill. |
| **R2 bucket** | Cloudflare | `Ready to Post` / `Archive` / `Needs Attention` export bundles (`final.mp4`, `thumbnail.jpg`, `caption.txt`, `clip-metadata.json`) | S3-API-compatible, zero egress fees for the reviewer/poster downloads that happen on every approved clip. |

## `render.yaml` sketch

```yaml
databases:
  - name: clipper-db
    plan: starter
    postgresMajorVersion: "16"

services:
  - type: web
    name: clipper-api
    runtime: node
    plan: starter          # not free — see "Cold starts" below
    buildCommand: npm ci && npm run build
    preDeployCommand: npm run migrate   # runs schema migrations before the new version goes live
    startCommand: npm run start:api
    healthCheckPath: /health
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: clipper-db
          property: connectionString
      - key: R2_ACCOUNT_ID
        sync: false
      - key: R2_ACCESS_KEY_ID
        sync: false
      - key: R2_SECRET_ACCESS_KEY
        sync: false
      - key: R2_BUCKET_NAME
        sync: false
      - key: OPUSCLIP_API_KEY
        sync: false          # set manually in the Render dashboard, never committed
      - key: GOOGLE_API_KEY
        sync: false
      - key: ANTHROPIC_API_KEY
        sync: false
      - key: NOTIFY_WEBHOOK_URL
        sync: false

  - type: cron
    name: clipper-sync
    runtime: node
    plan: starter
    schedule: "*/10 * * * *"
    buildCommand: npm ci && npm run build
    startCommand: npm run sync
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: clipper-db
          property: connectionString
      - key: OPUSCLIP_API_KEY
        sync: false
      - key: OPUSCLIP_DAILY_CREDIT_BUDGET
        sync: false
      - key: R2_ACCOUNT_ID
        sync: false
      - key: R2_ACCESS_KEY_ID
        sync: false
      - key: R2_SECRET_ACCESS_KEY
        sync: false
      - key: R2_BUCKET_NAME
        sync: false
      - key: NOTIFY_WEBHOOK_URL
        sync: false
```

Both `clipper-api` and `clipper-sync` build from the same repo/codebase — they're two entrypoints (`start:api` vs `sync` in `package.json`) into the same `src/`, not two separate apps. Keep it that way; splitting the repo later would fight the module boundaries in `ARCHITECTURE.md` for no benefit yet.

`clipper-db`'s connection string from Render's `fromDatabase` wiring is a direct connection, not a pooled one — no connection-mode caveats to document here, unlike a pooled provider.

## The Claude operator

The operator isn't a Render service. It's a Claude Code Routine (scheduled trigger) on this repository that runs the `clipper-operator` skill a few times a day and on demand. Its environment needs network access to Content Rewards, Google Docs/Drive, YouTube and OpusClip, plus these secrets: `DATABASE_URL` (Render's *external* connection string, restricted by IP allowlist where possible), `OPUSCLIP_API_KEY`, `OPUSCLIP_DAILY_CREDIT_BUDGET` and `NOTIFY_WEBHOOK_URL`. It never needs R2 or reviewer credentials, because it can't approve or package anything.

## Cold starts and the webhook

Render's **free** web service tier spins down after inactivity and takes a noticeable moment to wake on the next request. That's a real problem for a webhook receiver — OpusClip calling back to a cold service risks a dropped or delayed delivery. Two ways this is already covered rather than needing new design:

1. Use at least the **Starter** (always-on) plan for `clipper-api`, not Free, once this is more than a local experiment.
2. Even so, don't rely on the webhook being delivered — `project-monitor`'s polling path (already required as the source of truth in `ARCHITECTURE.md` / `API_CONTRACTS.md`) means a missed or delayed webhook just means the poll catches it a bit later, not a lost clip.

## Migrations

Render's **Pre-Deploy Command** (`npm run migrate` above) runs against the new release before it receives traffic. This keeps `clipper-api` and the next `clipper-sync` run from ever running against a schema they don't expect during a deploy.

## Secrets

Every secret in `config.ts`'s required list — `OPUSCLIP_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `NOTIFY_WEBHOOK_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, plus `DATABASE_URL` which Render injects automatically from the database resource — is set directly in the Render dashboard per service, `sync: false` in the blueprint so `render.yaml` itself never carries values. Never commit a `.env` with real values — `.env` should be in `.gitignore` from the first commit. The R2 access key pair is scoped to the one bucket, not account-wide, when created in the Cloudflare dashboard.

## Health check

`clipper-api` needs a `GET /health` route returning 200 as soon as the DB connection is confirmed live — this is what Render's `healthCheckPath` uses to decide the deploy succeeded and to keep routing traffic to the instance. Build this in task 0 of `BUILD_PLAN.md`, not as an afterthought.

## Local development vs. deployed

Nothing above blocks local development — `docker-compose` (or a local Postgres) plus a `.env` pointing at a separate dev R2 bucket covers that, and should be set up before Render enters the picture at all. Render is where Phase 1's end-to-end smoke test (`BUILD_PLAN.md` task 14) should ultimately run against, once there's a deployable build, so that "works deployed" is verified before calling Phase 1 done — not assumed from local-only testing.
