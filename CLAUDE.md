# Clipper

A clip-automation pipeline: Content Rewards campaigns → footage → OpusClip → human review → Ready to Post. Read `docs/ROADMAP.md` (direction + current status), `README.md` (spec) and `docs/ARCHITECTURE.md` (design) before changing anything. Keep `docs/ROADMAP.md` §5–7 current when a task finishes.

## Two modes of working in this repo

- **Developing the platform:** follow `docs/BUILD_PLAN.md` in order. Each task has a "done when" check; verify it before moving on.
- **Operating the pipeline** ("do an operator run", "scout campaigns", "onboard this campaign"): runs are **manual only**: a person asks, and nothing is ever scheduled. Use the `clipper-operator` skill in `.claude/skills/`. In this mode you act only through the `clipper` CLI and the OpusClip connector, and only submit to OpusClip with parameters from `clipper source reserve`. A hook in `.claude/settings.json` blocks anything else; don't weaken or bypass it. In the cloud, `CLIPPER_OPERATOR_TOKEN` makes every `clipper` command run on the review app over HTTPS (the cloud can't open Postgres connections); the commands and rules are the same.

## The split to preserve

Code guards state (dedupe, credit budget, caption validation, the approval gate). Claude does reading and judgment through the playbook. People approve, join and post. Never add a CLI command that approves clips, activates campaigns, joins campaigns or posts. The one decision the CLI can make is rejecting clips, and only for a named person who asked (`clipper candidate reject --requested-by`).

## Commands

```bash
npm test                                   # unit + DB tests (DB tests need TEST_DATABASE_URL; they wipe that DB)
RUN_NETWORK_TESTS=1 npm test -- live       # live Content Rewards canary
npm run typecheck && npm run build
npm run db:generate                        # after editing src/db/schema.ts; never hand-edit migrations
```

## Conventions

- TypeScript ESM, strict. zod at every boundary with external data.
- Each module lives in `src/modules/<name>/` and is used through its exported functions only.
- Content Rewards parsing is reverse-engineered: keep it inside `campaign-connector`, and update `docs/API_CONTRACTS.md` when it changes.
- Status changes go through the entity's `transition()` helper so the `status_events` audit row is written in the same transaction.
