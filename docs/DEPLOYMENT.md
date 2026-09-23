# Deployment (Render + Cloudflare R2)

This maps the architecture in `ARCHITECTURE.md` onto concrete hosting. Nothing here is deployed yet — this is the target to build toward once Phase 1 code exists.

## Services

Two Render resources (web service + Postgres), a Cloudflare R2 bucket, and the Claude operator, which runs as a Claude Code Routine, not on Render (see below). There's no worker or cron: OpusClip is reached through the OpusClip connector, which only exists inside a Claude session, so the hourly operator run does the polling., plus a Cloudflare R2 bucket for file storage:

| Resource | Where | Runs | Why |
|---|---|---|---|
| **Web Service** | Render | Fastify app: `review-api` HTTP routes + the OpusClip webhook receiver (`server.ts`) | Needs a public HTTPS URL — this is what `conclusionActions` in `API_CONTRACTS.md` points at, and what a human reviewer's browser hits. |
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
      - key: REVIEWER_TOKEN
        sync: false
      - key: NOTIFY_WEBHOOK_URL
        sync: false
```

The operator runs the same codebase's `clipper` CLI from its own checkout of this repo, so there's one implementation of every rule. Keep it that way; splitting the repo later would fight the module boundaries in `ARCHITECTURE.md` for no benefit yet.

`clipper-db`'s connection string from Render's `fromDatabase` wiring is a direct connection, not a pooled one — no connection-mode caveats to document here, unlike a pooled provider.

## The Claude operator

The operator isn't a Render service. It's a Claude Code Routine (scheduled trigger) on this repository that runs the `clipper-operator` skill hourly and on demand. It needs:

- **The OpusClip connector** attached (Pro plan; the org is fixed at connect time, so connect the right one).
- **Network access** to Content Rewards, Google Docs/Drive, YouTube and your Postgres.
- **Secrets:** `DATABASE_URL` (Render's *external* connection string, restricted by IP allowlist where possible), `OPUSCLIP_DAILY_CREDIT_BUDGET`, `NOTIFY_WEBHOOK_URL`, and the bucket-scoped R2 key pair (for `clipper package`, which refuses anything a person didn't approve).
- **This repo's `.claude/settings.json` in force.** It holds the submit guard hook and the denied posting/sharing tools. Check this in the Routine's environment before relying on it (BUILD_PLAN task 13).

It never needs `REVIEWER_TOKEN`: approval happens only in the web app.

## Review web app sign-in

Reviewers sign in at the web service's URL with their name and `REVIEWER_TOKEN` (at least 24 characters; generate one with `openssl rand -base64 32`). The session cookie is `Secure`, so the app must be served over HTTPS; Render's default `onrender.com` domain already is. Rotating `REVIEWER_TOKEN` signs everyone out. The sign-in throttle is in memory, which is fine for one instance. If the service ever scales out, put the app behind an SSO proxy or a shared rate limit.

## Cold starts and the webhook

Render's **free** web service tier spins down after inactivity and takes a noticeable moment to wake on the next request. That's a real problem for a webhook receiver — OpusClip calling back to a cold service risks a dropped or delayed delivery. Two ways this is already covered rather than needing new design:

1. Use at least the **Starter** (always-on) plan for `clipper-api`, not Free, once this is more than a local experiment.
2. Even so, don't rely on the webhook being delivered — `project-monitor`'s polling path (already required as the source of truth in `ARCHITECTURE.md` / `API_CONTRACTS.md`) means a missed or delayed webhook just means the poll catches it a bit later, not a lost clip.

## Migrations

Render's **Pre-Deploy Command** (`npm run migrate` above) runs against the new release before it receives traffic. The operator's CLI reads the same database, so deploy schema changes before merging operator code that needs them.

## Secrets

Every secret the services use — `REVIEWER_TOKEN`, `NOTIFY_WEBHOOK_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, plus `DATABASE_URL` which Render injects automatically from the database resource — is set directly in the Render dashboard per service, `sync: false` in the blueprint so `render.yaml` itself never carries values. Never commit a `.env` with real values — `.env` should be in `.gitignore` from the first commit. The R2 access key pair is scoped to the one bucket, not account-wide, when created in the Cloudflare dashboard.

## Health check

`clipper-api` needs a `GET /health` route returning 200 as soon as the DB connection is confirmed live — this is what Render's `healthCheckPath` uses to decide the deploy succeeded and to keep routing traffic to the instance. Build this in task 0 of `BUILD_PLAN.md`, not as an afterthought.

## Local development vs. deployed

Nothing above blocks local development — `docker-compose` (or a local Postgres) plus a `.env` pointing at a separate dev R2 bucket covers that, and should be set up before Render enters the picture at all. Render is where Phase 1's end-to-end smoke test (`BUILD_PLAN.md` task 14) should ultimately run against, once there's a deployable build, so that "works deployed" is verified before calling Phase 1 done — not assumed from local-only testing.
