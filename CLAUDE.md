# Clipper

A clip-automation pipeline: Content Rewards campaigns → footage → OpusClip → human review → Ready to Post. Read `docs/ROADMAP.md` (direction + current status), `README.md` (spec) and `docs/ARCHITECTURE.md` (design) before changing anything. The social accounts clips go to are in `docs/SOCIAL_ACCOUNTS.md`. Keep `docs/ROADMAP.md` §5–7 current when a task finishes.

## Two modes of working in this repo

- **Developing the platform:** follow `docs/BUILD_PLAN.md` in order. Each task has a "done when" check; verify it before moving on.
- **Operating the pipeline** ("do an operator run", "scout campaigns", "onboard this campaign"): runs are **manual only**: a person asks, and nothing is ever scheduled. Use the `clipper-operator` skill in `.claude/skills/`. In this mode you act only through the `clipper` CLI and the OpusClip connector, and only submit to OpusClip with parameters from `clipper source reserve`. A hook in `.claude/settings.json` blocks anything else; don't weaken or bypass it. In the cloud, `CLIPPER_OPERATOR_TOKEN` makes every `clipper` command run on the review app over HTTPS (the cloud can't open Postgres connections); the commands and rules are the same.

## The split to preserve

Code guards state (dedupe, credit budget, caption validation, the approval gate). Claude does reading and judgment through the playbook. People approve clips, join campaigns and post. Never add a CLI command that approves clips, joins campaigns or posts. Posting goes through OpusClip: `clipper social plan` issues the exact schedule params, a hook (`clipper guard post`) allows nothing else, the person confirms each post in OpusClip, and `clipper social sync` marks the clip posted only once every one of its posts is live with a link (standing rule, 2026-09-30; a failed or still-pending post leaves it to the person). Campaigns are activated by a reviewer, or by Claude under the standing rule set 2026-09-27: `clipper campaign activate`, only after `campaign verify-config` found the config matching the campaign page and brief (at most 3 correct-and-recheck rounds; anything unsettled goes to a person via Discord). The one decision the CLI can make is rejecting clips: for a named person who asked (`clipper candidate reject --requested-by`), or under the standing rule the user set on 2026-09-27 (`clipper candidate reject-failed`: a recorded failed check **and** the operator's own pre-screen verdict of reject). Rejects are final. Don't widen that rule to taste-only rejects. Deleting a campaign follows the on-request pattern only (2026-09-30): `clipper campaign delete <id> --reason --requested-by` for a named person who asked in the conversation, never on Claude's own judgment, and refused once any of its clips was posted. Every clip must be in English (`english_language` check, 2026-09-28): a non-English clip fails it and goes under that rule, and non-English footage is skipped before any credits are spent. Claude may also fix a clip's failed checks with OpusClip edits on its own (standing rule, 2026-09-27); `clipper guard edit` limits that to fixing ops, at most 2 per clip, and the fixed clip is reviewed again. Captions are per video (2026-09-30): a video that already has burned-in captions is submitted with OpusClip's captions off (`footage select --source-captions` / `source mark-captions`), and a clip whose visual review failed `no_double_captions` may have OpusClip's captions switched off as that automatic fix, the only case where captions may be turned off.

## Commands

```bash
npm test                                   # unit + DB tests (DB tests need TEST_DATABASE_URL; they wipe that DB)
RUN_NETWORK_TESTS=1 npm test -- live       # live Content Rewards canary
npm run typecheck && npm run build
npm run db:generate                        # after editing src/db/schema.ts; never hand-edit migrations
```

## Conventions

- **Promotion is always feature branch → `develop` → `main`.** Open the feature PR against `develop`, merge it, then open a `develop` → `main` PR. Never PR or push a feature branch straight to `main`.
- TypeScript ESM, strict. zod at every boundary with external data.
- Each module lives in `src/modules/<name>/` and is used through its exported functions only.
- Content Rewards parsing is reverse-engineered: keep it inside `campaign-connector`, and update `docs/API_CONTRACTS.md` when it changes.
- Status changes go through the entity's `transition()` helper so the `status_events` audit row is written in the same transaction.
