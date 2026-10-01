import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listCandidates,
  prescreenCandidate,
  recordEdit,
  recordVisualReview,
  rejectCandidates,
  rejectFailedCandidates,
  setCaption,
  showCandidate,
  stalePreviews,
  upsertCandidates,
} from "../../modules/candidates/index.js";
import { DEFAULT_EVERY_SEC, extractFrames } from "../../modules/frames/index.js";
import { proxiedFetch } from "../proxy-fetch.js";
import { resolveCampaign } from "../../modules/campaigns/index.js";
import { recordExport } from "../../modules/packaging/index.js";
import { positional, readJsonInput, readTextInput, requiredOption, UsageError, type Command, type CommandContext } from "../run.js";

// There is deliberately no approve / needs-edit / post command here: those are
// a reviewer's decisions, made in the review web app. Rejecting is the one
// exception: for a person who asked for it by name (`reject --requested-by`),
// or under the standing rule for clips with failed checks (`reject-failed`).

const moduleCtx = (ctx: CommandContext) => ({ db: ctx.db(), actor: ctx.actor });

export const candidateCommands: Record<string, Command> = {
  upsert: {
    summary:
      "Store an opusclip_list_clips result for a job: dedupe by clip ID, run objective checks, new candidates → awaiting_review; job → processing / candidates_ready / needs_attention by stage.",
    usage: "<sourceJobId> --file <clips.json | ->",
    options: { file: { type: "string" } },
    run: async (ctx) =>
      upsertCandidates(moduleCtx(ctx), positional(ctx, 0, "sourceJobId"), await readJsonInput(ctx, requiredOption(ctx, "file"))),
  },
  list: {
    summary: "(read-only) Candidates, oldest first, with OpusClip metadata, check results, pre-screen and caption.",
    usage: "[--status <status>] [--campaign <id>] [--job <sourceJobId>]",
    options: { status: { type: "string" }, campaign: { type: "string" }, job: { type: "string" } },
    run: async (ctx) => {
      const db = ctx.db();
      const campaignId = ctx.options.campaign ? (await resolveCampaign(db, ctx.options.campaign as string)).id : undefined;
      return listCandidates(db, { status: ctx.options.status as string | undefined, campaignId, jobId: ctx.options.job as string | undefined });
    },
  },
  "stale-previews": {
    summary:
      "(read-only) Jobs with clips still awaiting a person (awaiting_review, needs_edit, approved) whose preview link has expired or expires within --within-hours (default 12; links last 24 h). Renew with opusclip_list_clips + `candidate upsert` for each job.",
    usage: "[--within-hours <h>]",
    options: { "within-hours": { type: "string" } },
    run: (ctx) => {
      const raw = ctx.options["within-hours"] as string | undefined;
      const withinHours = raw === undefined ? undefined : Number(raw);
      if (withinHours !== undefined && !(withinHours >= 0)) throw new UsageError("--within-hours must be a number of hours, 0 or more");
      return stalePreviews(ctx.db(), { withinHours });
    },
  },
  show: {
    summary: "(read-only) One candidate, as `list` shows it, plus `visualChecks`: the checks its visual review must cover.",
    usage: "<candidateId>",
    run: (ctx) => showCandidate(ctx.db(), positional(ctx, 0, "candidateId")),
  },
  frames: {
    summary:
      "(local, read-only) Download a candidate's preview and write still frames + contact sheets to a local folder for a visual review. Opening sampled densely, then every --every seconds; --at adds full-size stills (e.g. to read a caption word).",
    usage: "<candidateId> [--out <dir>] [--every <sec>] [--at <sec,sec,...>]",
    options: { out: { type: "string" }, every: { type: "string" }, at: { type: "string" } },
    exitCode: (r) => ((r as { error?: unknown }).error ? 1 : 0),
    run: async (ctx) => {
      // The frames are for the operator to look at, so they're written where the operator runs, never on the server.
      if (!ctx.allowFilePaths) throw new UsageError("`candidate frames` runs on the operator's machine, not over the operator endpoint");
      const id = positional(ctx, 0, "candidateId");
      const every = ctx.options.every === undefined ? DEFAULT_EVERY_SEC : Number(ctx.options.every);
      const at = typeof ctx.options.at === "string" ? ctx.options.at.split(",").map((s) => Number(s.trim())) : [];
      if (!(every > 0) || at.some((t) => !Number.isFinite(t))) throw new UsageError("--every and --at take seconds");

      let candidate: { previewUrl?: string | null; durationMs?: number | null; visualChecks?: string[]; title?: string | null };
      if (ctx.showCandidate) {
        const res = await ctx.showCandidate(id);
        if (res.exitCode !== 0) return res.output as object;
        candidate = res.output as typeof candidate;
      } else candidate = await showCandidate(ctx.db(), id);
      if (!candidate.previewUrl) throw new UsageError(`Candidate ${id} has no preview URL; upsert its job again with a fresh opusclip_list_clips`);

      const outDir = typeof ctx.options.out === "string" ? ctx.options.out : join(tmpdir(), "clipper-frames", id);
      const doFetch = ctx.env.HTTPS_PROXY || ctx.env.https_proxy ? await proxiedFetch() : fetch;
      const result = await extractFrames({
        url: candidate.previewUrl,
        outDir,
        durationSec: candidate.durationMs ? candidate.durationMs / 1000 : undefined,
        everySec: every,
        at,
        fetch: doFetch,
      });
      return {
        id,
        title: candidate.title ?? null,
        visualChecks: candidate.visualChecks ?? [],
        outDir,
        durationSec: result.durationSec,
        sheets: result.sheets,
        stills: result.stills,
        frames: result.frames.length,
        next: `Look at every sheet, then record \`clipper candidate visual-review ${id} --file review.json\` covering each of visualChecks.`,
      };
    },
  },
  "visual-review": {
    summary:
      "Record what the frames showed: a result (pass | fail | manual_review_required) and evidence for every check in `show`'s visualChecks. Required before a recommend or hold pre-screen; a failed check makes approval need the reviewer's override.",
    usage: "<candidateId> --file <review.json | ->   (review.json: {framesChecked, summary, checks: {<name>: {result, evidence}}})",
    options: { file: { type: "string" } },
    run: async (ctx) =>
      recordVisualReview(moduleCtx(ctx), positional(ctx, 0, "candidateId"), await readJsonInput(ctx, requiredOption(ctx, "file"))),
  },
  prescreen: {
    summary: "Record an advisory verdict (recommend | hold | reject) with notes. Never approves; changes no status.",
    usage: '<candidateId> --verdict <recommend|hold|reject> --notes "..."',
    options: { verdict: { type: "string" }, notes: { type: "string" } },
    run: (ctx) =>
      prescreenCandidate(moduleCtx(ctx), positional(ctx, 0, "candidateId"), requiredOption(ctx, "verdict"), requiredOption(ctx, "notes")),
  },
  reject: {
    summary:
      "Reject clips a person asked to have rejected: the listed ones, or every clip of --campaign still awaiting_review / needs_edit. Only when a person asks; never on your own judgment.",
    usage: '<candidateId...> | --campaign <id> --reason "..." --requested-by <name>',
    options: { campaign: { type: "string" }, reason: { type: "string" }, "requested-by": { type: "string" } },
    run: async (ctx) => {
      const campaignId = ctx.options.campaign ? (await resolveCampaign(ctx.db(), ctx.options.campaign as string)).id : undefined;
      return rejectCandidates(
        moduleCtx(ctx),
        { ids: ctx.positionals, campaignId },
        requiredOption(ctx, "reason"),
        requiredOption(ctx, "requested-by"),
      );
    },
  },
  "reject-failed": {
    summary:
      "Standing rule: reject every clip waiting on a decision that has a failed check AND your pre-screen verdict of reject. Held clips and taste-only rejects are left for a person. Run it after pre-screening.",
    usage: "[--campaign <id>]",
    options: { campaign: { type: "string" } },
    run: async (ctx) => {
      const campaignId = ctx.options.campaign ? (await resolveCampaign(ctx.db(), ctx.options.campaign as string)).id : undefined;
      return rejectFailedCandidates(moduleCtx(ctx), { campaignId });
    },
  },
  "set-caption": {
    summary: "Store a caption draft, only if it has every required phrase, tag and disclosure and stays within the hashtag limit.",
    usage: "<candidateId> --file <caption.txt | ->",
    options: { file: { type: "string" } },
    run: async (ctx) => setCaption(moduleCtx(ctx), positional(ctx, 0, "candidateId"), await readTextInput(ctx, requiredOption(ctx, "file"))),
  },
  "record-export": {
    summary: "Store the HD export_url from opusclip_export_clip for an approved candidate (then run `clipper package`).",
    usage: "<candidateId> --url <exportUrl>",
    options: { url: { type: "string" } },
    run: (ctx) => recordExport(moduleCtx(ctx), positional(ctx, 0, "candidateId"), requiredOption(ctx, "url")),
  },
  "record-edit": {
    summary:
      "Log an opusclip_edit_clip call: for a reviewer's needs_edit request (→ awaiting_review), or with --fixes as an automatic fix of failed checks (stays awaiting_review; visual review and pre-screen start over).",
    usage: '<candidateId> --ops-file <ops.json | -> --reason "<what was wrong → what you changed>" [--fixes <check,check>]',
    options: { "ops-file": { type: "string" }, reason: { type: "string" }, fixes: { type: "string" } },
    run: async (ctx) =>
      recordEdit(
        moduleCtx(ctx),
        positional(ctx, 0, "candidateId"),
        await readJsonInput(ctx, requiredOption(ctx, "ops-file")),
        requiredOption(ctx, "reason"),
        typeof ctx.options.fixes === "string" ? ctx.options.fixes.split(",").map((s) => s.trim()).filter(Boolean) : [],
      ),
  },
};
