import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { TransitionError } from "../db/transition.js";
import { CANDIDATE_CLIP_STATUSES, POST_PLATFORMS, type CandidateClipStatus } from "../db/schema.js";
import { InvalidConfigError, validateCampaignConfig, type CampaignConfig } from "../modules/campaign-config/index.js";
import { CandidatesError, rejectCandidates, setCaption } from "../modules/candidates/index.js";
import {
  campaignDetail,
  campaignsForReview,
  candidateDetail,
  candidatesByStatus,
  confirmCampaign,
  editCampaignConfig,
  decideCandidate,
  deleteCampaign,
  markPosted,
  recordPost,
  requestConfigChanges,
  ReviewError,
  setCampaignPaused,
  type ReviewCtx,
} from "../modules/review/index.js";
import { BUNDLE_FILES, type BundleStore } from "../modules/packaging/index.js";
import { postQueue } from "../modules/posting/index.js";
import { createSession, readCookie, REVIEWER_NAME, SESSION_COOKIE, sessionCookie, tokenMatches, verifySession } from "./auth.js";
import { badge, checkTally, fold, html, page, refreshHref, safeUrl, seconds, when, type Html } from "./html.js";

// The review web app: the one place a person confirms campaigns, decides clips
// and records posts. Every route except /login requires a signed-in reviewer,
// and every write goes through the review module as `reviewer:<name>`.

declare module "fastify" {
  interface FastifyRequest {
    reviewer: string | null;
  }
}

type Form = Record<string, string>;
export type ReviewAppOptions = { db: Db; reviewerToken: string; now?: () => Date; bundles?: BundleStore };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN_WINDOW_MS = 15 * 60_000;
const POST_STATUS_LABELS: Record<string, string> = {
  planned: "Being scheduled",
  requested: "Waiting for you to confirm",
  scheduled: "Scheduled",
  posted: "Live",
  failed: "Failed",
  cancelled: "Cancelled",
};
const LOGIN_MAX_FAILURES = 10;

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; media-src https:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  // Preview URLs are signed; don't leak them (or our paths) to other sites. Not
  // "no-referrer": that makes browsers send `Origin: null` on our own form posts.
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};

function flashOf(req: FastifyRequest) {
  const q = req.query as Record<string, string | undefined>;
  return { ok: q.ok, error: q.error };
}

function back(reply: FastifyReply, path: string, flash: { ok?: string; error?: string }) {
  const qs = new URLSearchParams(Object.entries(flash).filter(([, v]) => v) as [string, string][]).toString();
  return reply.redirect(qs ? `${path}?${qs}` : path, 303);
}

function errorMessage(err: unknown): string | undefined {
  if (err instanceof InvalidConfigError) return `${err.message}: ${err.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`;
  if (err instanceof ReviewError || err instanceof CandidatesError || err instanceof TransitionError) return err.message;
  return undefined;
}

/** Runs a write, then redirects back with a success or error message. Unexpected errors still surface as 500s. */
async function act(reply: FastifyReply, path: string, ok: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    return back(reply, path, { ok });
  } catch (err) {
    const msg = errorMessage(err);
    if (msg === undefined) throw err;
    return back(reply, path, { error: msg });
  }
}


export function registerReviewRoutes(app: FastifyInstance, opts: ReviewAppOptions) {
  const { db, reviewerToken } = opts;
  const ctx = (req: FastifyRequest): ReviewCtx => ({ db, actor: `reviewer:${req.reviewer}`, now: opts.now });
  const failures = new Map<string, number[]>();

  app.decorateRequest("reviewer", null);
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    if (String(reply.getHeader("content-type") ?? "").startsWith("text/html")) reply.headers(SECURITY_HEADERS);
    return payload;
  });

  const send = (reply: FastifyReply, htmlText: string, code = 200) => reply.code(code).type("text/html; charset=utf-8").send(htmlText);

  // --- sign in ---------------------------------------------------------------------

  const loginPage = (next: string, error?: string) =>
    page({
      title: "Sign in",
      flash: { error },
      body: html`<h1>Clipper review</h1>
        <form method="post" action="/login" class="card" style="max-width:420px">
          <input type="hidden" name="next" value="${next}">
          <label for="name">Your name</label>
          <input id="name" name="name" autocomplete="username" required pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,39}" placeholder="e.g. alex">
          <p class="muted">Recorded on every decision you make (letters, digits, . _ -).</p>
          <label for="token">Reviewer token</label>
          <input id="token" name="token" type="password" autocomplete="current-password" required>
          <button>Sign in</button>
        </form>`,
    });

  const safeNext = (n: string | undefined) => (n && n.startsWith("/") && !n.startsWith("//") ? n : "/");

  app.get("/login", async (req, reply) => send(reply, loginPage(safeNext((req.query as Form).next))));

  app.post("/login", async (req, reply) => {
    const form = (req.body ?? {}) as Form;
    const next = safeNext(form.next);
    const ip = req.ip;
    const now = Date.now();
    const recent = (failures.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_MAX_FAILURES) return send(reply, loginPage(next, "Too many failed attempts. Try again in 15 minutes."), 429);
    const name = (form.name ?? "").trim();
    if (!tokenMatches(form.token ?? "", reviewerToken) || !REVIEWER_NAME.test(name)) {
      failures.set(ip, [...recent, now]);
      return send(reply, loginPage(next, REVIEWER_NAME.test(name) ? "Wrong reviewer token." : "Name: letters, digits, . _ - (max 40)."), 401);
    }
    failures.delete(ip);
    reply.header("set-cookie", sessionCookie(createSession(reviewerToken, name, opts.now?.())));
    return reply.redirect(next, 303);
  });

  app.post("/logout", async (_req, reply) => {
    reply.header("set-cookie", sessionCookie("", 0));
    return reply.redirect("/login", 303);
  });

  // --- everything else needs a reviewer ----------------------------------------------

  app.register(async (scope) => {
    scope.addHook("preHandler", async (req, reply) => {
      req.reviewer = verifySession(reviewerToken, readCookie(req.headers.cookie, SESSION_COOKIE), opts.now?.());
      if (!req.reviewer) {
        if (req.method === "GET") return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`, 303);
        return reply.code(401).type("text/plain").send("Sign in first.");
      }
      if (req.method === "POST") {
        // SameSite=Strict already keeps the cookie off cross-site requests; refuse them outright too.
        const origin = req.headers.origin;
        let sameOrigin = true;
        if (origin) {
          try {
            sameOrigin = new URL(origin).host === req.headers.host;
          } catch {
            sameOrigin = false;
          }
        }
        const fetchSite = req.headers["sec-fetch-site"];
        if (!sameOrigin || (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none")) {
          return reply.code(403).type("text/plain").send("Cross-site request refused.");
        }
      }
      const id = (req.params as { id?: string } | undefined)?.id;
      if (id !== undefined && !UUID.test(id)) return reply.code(404).type("text/plain").send("Not found.");
    });

    const view = (req: FastifyRequest, reply: FastifyReply, title: string, body: Html, code = 200) =>
      send(reply, page({ title, reviewer: req.reviewer!, path: refreshHref(req.url), flash: flashOf(req), body }), code);

    // Overview
    scope.get("/", async (req, reply) => {
      const all = await campaignsForReview(db);
      const pending = all.filter((c) => c.status === "pending_confirmation");
      const count = async (s: CandidateClipStatus) => (await candidatesByStatus(db, [s])).length;
      const [awaiting, needsEdit, approved, ready] = await Promise.all([count("awaiting_review"), count("needs_edit"), count("approved"), count("ready_to_post")]);
      return view(
        req,
        reply,
        "Overview",
        html`<h1>What needs you</h1>
          <div class="grid">
            <a class="card" href="/campaigns"><strong>${pending.length}</strong> campaign config${pending.length === 1 ? "" : "s"} to confirm</a>
            <a class="card" href="/review"><strong>${awaiting}</strong> clip${awaiting === 1 ? "" : "s"} awaiting review</a>
            <a class="card" href="/posts"><strong>${ready}</strong> ready to post</a>
          </div>
          <p class="muted">${needsEdit} sent back for edits (the operator fixes these) · ${approved} approved, waiting for export and packaging.</p>`,
      );
    });

    // --- campaigns -------------------------------------------------------------------

    scope.get("/campaigns", async (req, reply) => {
      const rows = await campaignsForReview(db);
      const order = ["pending_confirmation", "needs_attention", "active", "paused"];
      rows.sort((a, b) => (order.indexOf(a.status) + 1 || 99) - (order.indexOf(b.status) + 1 || 99));
      return view(
        req,
        reply,
        "Campaigns",
        html`<h1>Campaigns</h1>
          <div class="card scroll"><table>
            <tr><th>Campaign</th><th>Status</th><th>Type</th><th>Updated</th></tr>
            ${rows.map(
              (c) => html`<tr>
                <td><a href="/campaigns/${c.id}">${c.title ?? c.contentRewardsCampaignId}</a><br><span class="muted">${c.brand ?? ""}</span></td>
                <td>${c.status === "pending_confirmation" ? html`<span class="badge warn">to confirm</span>` : c.status.replace(/_/g, " ")}</td>
                <td>${c.campaignType ?? "unclassified"}</td>
                <td class="muted">${when(c.updatedAt)}</td>
              </tr>`,
            )}
          </table></div>`,
      );
    });

    scope.get("/campaigns/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      let d;
      try {
        d = await campaignDetail(db, id);
      } catch (err) {
        if (err instanceof ReviewError && err.code === "not_found") return view(req, reply, "Not found", html`<h1>No such campaign</h1>`, 404);
        throw err;
      }
      const c = d.campaign;
      // jsonb doesn't keep key order; show the settings that matter most first.
      const raw = c.config as CampaignConfig;
      const keys = ["clipGeneration", "requirements", "review", "extraction"] as const;
      const cfg: Partial<CampaignConfig> = Object.fromEntries(
        [...keys.filter((k) => k in raw), ...Object.keys(raw).filter((k) => !keys.includes(k as never))].map((k) => [k, raw[k as keyof CampaignConfig]]),
      );
      const gen = cfg.clipGeneration;
      const reqs = cfg.requirements;
      const summary = gen?.aspectRatio
        ? html`<ul>
            <li><strong>Clips:</strong> ${gen.aspectRatio}, ${gen.minDurationSeconds}–${gen.maxDurationSeconds}s, captions ${gen.captionsEnabled ? "on" : "off"}, ${gen.originalAudioOnly ? "original audio only" : "music allowed"}, template ${gen.brandTemplateId ?? "OpusClip default"}</li>
            ${reqs?.requiredCaptionLines?.length ? html`<li><strong>Caption must contain:</strong> ${reqs.requiredCaptionLines.map((l) => html`<code>${l}</code> `)}</li>` : ""}
            ${reqs?.requiredTags?.length ? html`<li><strong>Tags:</strong> ${reqs.requiredTags.join(" ")}</li>` : ""}
            ${reqs?.disclosureLines?.length ? html`<li><strong>Disclosure:</strong> ${reqs.disclosureLines.join(" ")}</li>` : ""}
            ${reqs?.requiredOnScreenText?.length ? html`<li><strong>On-screen text:</strong> ${reqs.requiredOnScreenText.join("; ")}</li>` : ""}
            ${reqs?.maxAdditionalHashtags !== undefined ? html`<li><strong>Extra hashtags allowed:</strong> ${reqs.maxAdditionalHashtags}</li>` : ""}
          </ul>`
        : "";
      const ext = cfg.extraction;
      const low = Object.entries(ext?.fieldConfidence ?? {}).filter(([, v]) => v === "low").map(([k]) => k);
      const snapshot = (c.crSnapshot ?? {}) as Record<string, unknown>;
      const brief = safeUrl(c.guidelineDocUrl);
      const cr = safeUrl(c.contentRewardsUrl);

      let actions: Html | string = "";
      if (c.status === "pending_confirmation") {
        actions = html`<h2>Confirm the config</h2>
          <div class="card">
            <p>The operator drafted this from the brief. Check it against the brief, fix anything wrong, then confirm. Confirming makes the campaign <strong>active</strong>, so the operator can start spending OpusClip credits on it.</p>
            ${summary}
            ${low.length ? html`<p><span class="badge warn">low confidence</span> ${low.join(", ")}</p>` : ""}
            ${ext?.unresolvedFields?.length ? html`<p><span class="badge warn">not in the brief</span> ${ext.unresolvedFields.join(", ")}</p>` : ""}
            ${ext?.unexpressedRules?.length
              ? html`<p><strong>Brief rules the config can't enforce</strong> (you check these per clip):</p><ul>${ext.unexpressedRules.map((r) => html`<li>${r}</li>`)}</ul>`
              : ""}
            <form method="post" action="/campaigns/${c.id}/confirm">
              <label for="config">Config (JSON)</label>
              <textarea id="config" name="config" rows="24" spellcheck="false">${JSON.stringify(cfg, null, 2)}</textarea>
              <label class="check"><input type="checkbox" name="checked" value="yes" required> I checked this against the brief</label>
              <button>Confirm and activate</button>
            </form>
          </div>
          <div class="card">
            <form method="post" action="/campaigns/${c.id}/request-changes">
              <label for="reason">Or send it back to the operator</label>
              <textarea id="reason" name="reason" rows="3" required placeholder="What's wrong or missing"></textarea>
              <button class="secondary">Request changes</button>
            </form>
          </div>`;
      } else if (c.status === "active" || c.status === "paused") {
        const paused = c.status === "paused";
        actions = html`${fold(
          html`Confirmed config <span class="muted">· by ${c.configConfirmedBy ?? "?"} ${when(c.configConfirmedAt)}</span>`,
          html`<form method="post" action="/campaigns/${c.id}/edit-config">
            <p>Change it here if something should work differently (e.g. <code>captionsEnabled</code>, <code>originalAudioOnly</code>). It applies to videos submitted from now on; clips already made keep their settings.</p>
            <label for="config">Config (JSON)</label>
            <textarea id="config" name="config" rows="24" spellcheck="false">${JSON.stringify(cfg, null, 2)}</textarea>
            <label class="check"><input type="checkbox" name="checked" value="yes" required> I checked this against the brief</label>
            <button>Save config</button>
          </form>`,
          )}
          <form method="post" action="/campaigns/${c.id}/${paused ? "resume" : "pause"}" class="card">
            <label for="reason">${paused ? "Resume" : "Pause"}: reason (optional)</label>
            <input id="reason" name="reason">
            <button class="${paused ? "" : "secondary"}">${paused ? "Resume campaign" : "Pause campaign"}</button>
            ${paused ? "" : html`<p class="muted">Paused campaigns get no new OpusClip submissions.</p>`}
          </form>`;
      } else if (Object.keys(cfg).length) {
        actions = fold("Config", html`<pre>${JSON.stringify(cfg, null, 2)}</pre>`);
      }

      return view(
        req,
        reply,
        c.title ?? "Campaign",
        html`<p><a href="/campaigns">← Campaigns</a></p>
          <h1>${c.title ?? c.contentRewardsCampaignId}</h1>
          <div class="card">
            <p><strong>Status:</strong> ${c.status.replace(/_/g, " ")} ${c.statusReason ? html`<span class="muted">(${c.statusReason})</span>` : ""}</p>
            <p><strong>Brand:</strong> ${c.brand ?? "?"} · <strong>Platforms:</strong> ${(c.platforms ?? []).join(", ")}</p>
            <p><strong>Type:</strong> ${c.campaignType ?? "unclassified"} ${c.campaignTypeReason ? html`<span class="muted">(${c.campaignTypeReason})</span>` : ""}</p>
            <p>${cr ? html`<a href="${cr}" target="_blank" rel="noopener noreferrer">Content Rewards page</a>` : ""}
               ${brief ? html` · <a href="${brief}" target="_blank" rel="noopener noreferrer">Brief</a>` : ""}</p>
            ${snapshot.payouts ? html`<details><summary>Payouts</summary><pre>${JSON.stringify(snapshot.payouts, null, 2)}</pre></details>` : ""}
          </div>
          ${actions}
          ${d.waitingClips
            ? html`<details class="card">
                <summary>Reject all ${d.waitingClips} clip${d.waitingClips === 1 ? "" : "s"} waiting for a decision</summary>
                <form method="post" action="/campaigns/${c.id}/reject-clips">
                  <p>Rejects every clip of this campaign that's awaiting review or needs an edit, with one reason. They won't come back when clips are collected again. OpusClip keeps its own copies.</p>
                  <label for="reject-reason">Why they're rejected</label>
                  <input id="reject-reason" name="reason" required>
                  <button class="secondary">Reject all</button>
                </form>
              </details>`
            : ""}
          <details class="card">
            <summary>Delete this campaign</summary>
            <form method="post" action="/campaigns/${c.id}/delete">
              <p>Removes the campaign with its footage, video jobs, clips and credit records, so it can be added again from scratch. Not possible once a clip was posted. OpusClip keeps its own projects.</p>
              <label for="confirm">Type <strong>delete</strong> to confirm</label>
              <input id="confirm" name="confirm" autocomplete="off" required>
              <button class="secondary">Delete campaign</button>
            </form>
          </details>
          ${fold(
            `History (${d.events.length} change${d.events.length === 1 ? "" : "s"})`,
            html`<div class="scroll"><table>
              ${d.events.map((e) => html`<tr><td class="muted">${when(e.createdAt)}</td><td>${e.fromStatus ?? "·"} → ${e.toStatus}</td><td>${e.actor}</td><td>${e.reason ?? ""}</td></tr>`)}
            </table></div>`,
          )}`,
      );
    });

    scope.post("/campaigns/:id/confirm", async (req, reply) => {
      const { id } = req.params as { id: string };
      const form = (req.body ?? {}) as Form;
      const path = `/campaigns/${id}`;
      if (form.checked !== "yes") return back(reply, path, { error: "Tick the box to confirm you checked the config against the brief." });
      let config: unknown;
      try {
        config = JSON.parse(form.config ?? "");
      } catch (err) {
        return back(reply, path, { error: `Config isn't valid JSON: ${(err as Error).message}` });
      }
      return act(reply, path, "Confirmed. The campaign is active.", () => confirmCampaign(ctx(req), id, config));
    });

    scope.post("/campaigns/:id/edit-config", async (req, reply) => {
      const { id } = req.params as { id: string };
      const form = (req.body ?? {}) as Form;
      const path = `/campaigns/${id}`;
      if (form.checked !== "yes") return back(reply, path, { error: "Tick the box to confirm you checked the config against the brief." });
      let config: unknown;
      try {
        config = JSON.parse(form.config ?? "");
      } catch (err) {
        return back(reply, path, { error: `Config isn't valid JSON: ${(err as Error).message}` });
      }
      return act(reply, path, "Config saved. It applies to the next videos submitted.", () => editCampaignConfig(ctx(req), id, config));
    });

    scope.post("/campaigns/:id/delete", async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        await deleteCampaign(ctx(req), id, ((req.body ?? {}) as Form).confirm);
      } catch (err) {
        const msg = errorMessage(err);
        if (msg === undefined) throw err;
        return back(reply, `/campaigns/${id}`, { error: msg });
      }
      return back(reply, "/campaigns", { ok: "Campaign deleted." });
    });

    scope.post("/campaigns/:id/reject-clips", async (req, reply) => {
      const { id } = req.params as { id: string };
      const path = `/campaigns/${id}`;
      try {
        const { count } = await rejectCandidates(ctx(req), { campaignId: id }, ((req.body ?? {}) as Form).reason ?? "");
        return back(reply, path, { ok: `Rejected ${count} clip${count === 1 ? "" : "s"}.` });
      } catch (err) {
        const msg = errorMessage(err);
        if (msg === undefined) throw err;
        return back(reply, path, { error: msg });
      }
    });

    scope.post("/campaigns/:id/request-changes", async (req, reply) => {
      const { id } = req.params as { id: string };
      return act(reply, `/campaigns/${id}`, "Sent back to the operator.", () => requestConfigChanges(ctx(req), id, ((req.body ?? {}) as Form).reason ?? ""));
    });

    for (const [verb, paused] of [["pause", true], ["resume", false]] as const) {
      scope.post(`/campaigns/:id/${verb}`, async (req, reply) => {
        const { id } = req.params as { id: string };
        return act(reply, `/campaigns/${id}`, paused ? "Paused." : "Resumed.", () => setCampaignPaused(ctx(req), id, paused, ((req.body ?? {}) as Form).reason));
      });
    }

    // --- review queue ------------------------------------------------------------------

    scope.get("/review", async (req, reply) => {
      const q = req.query as Form;
      const status = (CANDIDATE_CLIP_STATUSES as readonly string[]).includes(q.status ?? "") ? (q.status as CandidateClipStatus) : "awaiting_review";
      const campaignId = q.campaign && UUID.test(q.campaign) ? q.campaign : undefined;
      const rows = await candidatesByStatus(db, [status], campaignId);
      return view(
        req,
        reply,
        "Review queue",
        html`<h1>Review queue <span class="muted">· ${status.replace(/_/g, " ")} (${rows.length})</span></h1>
          <p class="actions">${(["awaiting_review", "needs_edit", "approved", "rejected"] as const).map(
            (s) => html`<a href="/review?status=${s}">${s.replace(/_/g, " ")}</a>`,
          )}</p>
          ${rows.length === 0 ? html`<p class="muted">Nothing here.</p>` : ""}
          ${rows.map(({ clip, job, campaign }) => {
            // Failures first, then anything needing a look, then passes.
            const rank = (v: string) => (v === "fail" ? 0 : v === "pass" ? 2 : 1);
            const checks = Object.entries(clip.checkResults ?? {}).sort(([, a], [, b]) => rank(a) - rank(b));
            const passed = checks.filter(([, v]) => v === "pass").length;
            const failed = checks.filter(([, v]) => v === "fail").length;
            const toCheck = checks.length - passed - failed;
            const thumb = safeUrl(clip.thumbnailUrl);
            const verdict = clip.prescreenVerdict;
            const tone = verdict === "recommend" ? "ok" : verdict === "reject" ? "bad" : verdict ? "warn" : "";
            // One badge summing up the checks, so a closed row still says what needs a look.
            const tally = !checks.length
              ? ""
              : failed
                ? html`<span class="badge bad">${failed} failed</span>`
                : toCheck
                  ? html`<span class="badge warn">${toCheck} to check</span>`
                  : html`<span class="badge ok">all pass</span>`;
            // Collapsed to one row so a long queue fits on a screen; tap to see checks and notes.
            return html`<details class="card qitem">
              <summary>
                ${thumb ? html`<img class="qthumb" src="${thumb}" alt="">` : html`<span class="qthumb muted"></span>`}
                <span class="qmain">
                  <span class="qtitle">${clip.title ?? clip.opusclipClipId}</span>
                  <span class="muted qmeta">${seconds(clip.durationMs)} · score ${clip.opusclipScore ?? "?"} · ${campaign.title}</span>
                  <span class="qtags">${verdict ? html`<span class="badge ${tone}">${verdict}</span>` : html`<span class="badge">not pre-screened</span>`}${tally}</span>
                </span>
              </summary>
              <div class="qbody">
                <p class="muted clip-meta">${job.sourceName ?? job.sourceKey}</p>
                ${checks.length ? fold(checkTally(checks), html`<ul class="checks">${checks.map(([k, v]) => html`<li>${badge(v)}<span>${k.replace(/_/g, " ")}</span></li>`)}</ul>`) : ""}
                ${verdict ? html`<p class="verdict ${tone}"><strong>Operator:</strong> ${clip.prescreenNotes ?? ""}</p>` : html`<p class="muted">Not pre-screened yet.</p>`}
                <p class="actions"><a class="button" href="/candidates/${clip.id}">Open clip to review →</a></p>
              </div>
            </details>`;
          })}`,
      );
    });

    scope.get("/candidates/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      let d;
      try {
        d = await candidateDetail(db, id);
      } catch (err) {
        if (err instanceof ReviewError && err.code === "not_found") return view(req, reply, "Not found", html`<h1>No such candidate</h1>`, 404);
        throw err;
      }
      const { clip, job, campaign } = d;
      let req_: ReturnType<typeof validateCampaignConfig>["requirements"] | undefined;
      let unexpressed: string[] = [];
      try {
        const cfg = validateCampaignConfig(campaign.config);
        req_ = cfg.requirements;
        unexpressed = cfg.extraction.unexpressedRules;
      } catch {
        req_ = undefined;
      }
      const preview = safeUrl(clip.previewUrl);
      const poster = safeUrl(clip.thumbnailUrl);
      const checks = Object.entries(clip.checkResults ?? {});
      const anyFail = checks.some(([k, v]) => v === "fail" && k !== "caption_compliance");
      // Evidence is shown only for the render it describes; an edit since makes it stale.
      const visual = clip.visualReview && clip.visualReview.edits === clip.editLog.length ? clip.visualReview : null;
      const deciding = clip.status === "awaiting_review";
      const captionEditable = clip.status === "awaiting_review" || clip.status === "needs_edit";
      const postable = clip.status === "ready_to_post" || clip.status === "posted";
      const signer = opts.bundles?.signedUrl;
      const downloads =
        clip.packageKey && signer
          ? await Promise.all(BUNDLE_FILES.map(async (f) => ({ file: f, url: await signer(`${clip.packageKey}${f}`, 3600) })))
          : [];
      const list = (label: string, items: string[] | undefined) =>
        items?.length ? html`<li><strong>${label}:</strong> ${items.map((i) => html`<code>${i}</code> `)}</li>` : "";

      return view(
        req,
        reply,
        clip.title ?? "Candidate",
        html`<p><a href="/review">← Review queue</a></p>
          <h1>${clip.title ?? clip.opusclipClipId}</h1>
          <p class="muted">${campaign.title} · ${job.sourceName ?? job.sourceKey} · status <strong>${clip.status.replace(/_/g, " ")}</strong></p>
          <div class="grid">
            <div>${preview ? html`<video controls preload="metadata" src="${preview}" poster="${poster ?? ""}"></video>` : html`<div class="card muted">No preview URL.</div>`}</div>
            <div class="card">
              <p><strong>Duration</strong> ${seconds(clip.durationMs)} · <strong>Score</strong> ${clip.opusclipScore ?? "?"}
                ${clip.opusclipSubScores ? html`<span class="muted">(${Object.entries(clip.opusclipSubScores).map(([k, v]) => `${k} ${v}`).join(", ")})</span>` : ""}</p>
              ${fold(
                checkTally(checks),
                html`<ul class="checks detail">${[...checks]
                  .sort(([, a], [, b]) => (a === "fail" ? 0 : a === "pass" ? 2 : 1) - (b === "fail" ? 0 : b === "pass" ? 2 : 1))
                  .map(
                    ([k, v]) =>
                      html`<li>${badge(v)}<span>${k.replace(/_/g, " ")}${visual?.checks[k] ? html`<br><small class="muted">${visual.checks[k].evidence}</small>` : ""}</span></li>`,
                  )}</ul>`,
              )}
              <p><strong>Operator's look at the frames</strong><br>${visual
                ? html`${visual.summary} <span class="muted">(${visual.framesChecked} frames, ${visual.at.slice(0, 16).replace("T", " ")} UTC)</span>`
                : html`<span class="muted">${clip.visualReview ? "out of date: the clip was edited since" : "not reviewed yet"}</span>`}</p>
              <p><strong>Operator pre-screen</strong><br>${clip.prescreenVerdict ? html`<strong>${clip.prescreenVerdict}</strong>: ${clip.prescreenNotes ?? ""}` : html`<span class="muted">none yet</span>`}</p>
              ${clip.description ? html`<p><strong>OpusClip description</strong><br>${clip.description} <span class="muted">${clip.hashtags ?? ""}</span></p>` : ""}
            </div>
          </div>

          ${fold(
            "The brief's rules",
            html`${req_
              ? html`<ul>
                  ${list("Caption must contain", req_.requiredCaptionLines)}
                  ${list("Tags", req_.requiredTags)}
                  ${list("Disclosure, on its own line", req_.disclosureLines)}
                  ${list("On-screen text (check the video)", req_.requiredOnScreenText)}
                  ${list("Overlays (check the video)", req_.requiredOverlayAssetIds)}
                  <li><strong>Extra hashtags allowed:</strong> ${req_.maxAdditionalHashtags}</li>
                  ${unexpressed.map((r) => html`<li>${r}</li>`)}
                </ul>`
              : html`<p class="bad">The campaign's config doesn't validate.</p>`}`,
          )}

          <h2>Caption</h2>
          <div class="card">
            ${clip.caption ? html`<pre>${clip.caption}</pre>` : html`<p class="muted">No caption yet. Approving needs one that passes the campaign's rules.</p>`}
            ${captionEditable
              ? html`<form method="post" action="/candidates/${clip.id}/caption">
                  <label for="caption">${clip.caption ? "Edit caption" : "Write a caption"}</label>
                  <textarea id="caption" name="caption" rows="6">${clip.caption ?? ""}</textarea>
                  <button class="secondary">Save caption (checked against the rules)</button>
                </form>`
              : ""}
          </div>

          ${deciding
            ? html`<h2>Decision</h2>
              <form method="post" action="/candidates/${clip.id}/decision" class="card">
                <label for="notes">Notes <span class="muted">(required for needs edit, reject and hold: say exactly what to fix, or why)</span></label>
                <textarea id="notes" name="notes" rows="3">${clip.reviewNotes ?? ""}</textarea>
                ${anyFail ? html`<label class="check"><input type="checkbox" name="override" value="yes"> Approve despite failed checks (explain in notes)</label>` : ""}
                <div class="actions">
                  <button name="decision" value="approve">Approve</button>
                  <button name="decision" value="needs_edit" class="secondary">Needs edit</button>
                  <button name="decision" value="hold" class="secondary">Hold</button>
                  <button name="decision" value="reject" class="danger">Reject</button>
                </div>
              </form>`
            : clip.status === "needs_edit"
              ? html`<div class="card"><p>Sent back for edits: ${clip.reviewNotes ?? ""}</p>
                  <form method="post" action="/candidates/${clip.id}/decision"><input type="hidden" name="decision" value="reject">
                  <label for="notes">Or reject it</label><input id="notes" name="notes" required placeholder="Why"><button class="danger">Reject</button></form></div>`
              : clip.reviewNotes
                ? html`<div class="card"><strong>Review notes:</strong> ${clip.reviewNotes}</div>`
                : ""}

          ${clip.packageKey
            ? html`<h2>Ready-to-Post bundle</h2>
              <div class="card">
                <p class="muted">Packaged ${when(clip.packagedAt)} · <code>${clip.packageKey}</code></p>
                ${downloads.length
                  ? html`<p class="actions">${downloads.map((d) => html`<a href="${d.url}" rel="noopener noreferrer">${d.file}</a>`)}</p><p class="muted">Links work for an hour.</p>`
                  : html`<p class="muted">Download links need the R2_* variables on the web service.</p>`}
              </div>`
            : ""}
          ${postable
            ? html`<h2>Posts</h2>
              <div class="card scroll">
                ${d.posts.length
                  ? html`<table>${d.posts.map(
                      (p) => html`<tr>
                        <td>${p.platform}${p.accountHandle ? html` <span class="muted">${p.accountHandle}</span>` : ""}</td>
                        <td>${POST_STATUS_LABELS[p.status] ?? p.status}${p.failureReason ? html` <span class="muted">(${p.failureReason})</span>` : ""}</td>
                        <td>${safeUrl(p.url)
                          ? html`<a href="${safeUrl(p.url)!}" target="_blank" rel="noopener noreferrer">${p.url}</a>`
                          : p.status === "requested" && safeUrl(p.approvalUrl)
                            ? html`<a class="button" href="${safeUrl(p.approvalUrl)!}" target="_blank" rel="noopener noreferrer">Confirm in OpusClip</a>`
                            : ""}</td>
                        <td class="muted">${p.status === "posted" ? when(p.postedAt) : p.publishAt ? `goes out ${when(p.publishAt)}` : ""}</td>
                      </tr>`,
                    )}</table>`
                  : html`<p class="muted">No posts yet. The next operator run schedules this clip on every account; you confirm each post in OpusClip.</p>`}
                ${clip.status === "ready_to_post" && d.posts.some((p) => p.status === "posted" && p.url)
                  ? html`<form method="post" action="/candidates/${clip.id}/mark-posted"><button>Mark posted</button> <span class="muted">Only needed if a post failed or is still waiting: the next sync marks it once every post is live with a link.</span></form>`
                  : ""}
                <details><summary class="muted">Record a post by hand</summary>
                  <form method="post" action="/candidates/${clip.id}/posts">
                    <div class="grid">
                      <div><label for="platform">Platform</label><select id="platform" name="platform">${POST_PLATFORMS.map((p) => html`<option>${p}</option>`)}</select></div>
                      <div><label for="url">Post URL</label><input id="url" name="url" type="url" required placeholder="https://"></div>
                    </div>
                    <button>Record post</button> <span class="muted">Only for posts made outside OpusClip.</span>
                  </form>
                </details>
              </div>`
            : ""}

          ${clip.editLog.length
            ? fold(
                `Edits made (${clip.editLog.length})`,
                html`${clip.editLog.map((e) => html`<p class="muted">${when(e.at)}</p><p>${e.reason}</p><pre>${JSON.stringify(e.ops)}</pre>`)}`,
              )
            : ""}
          ${fold(
            `History (${d.events.length} change${d.events.length === 1 ? "" : "s"})`,
            html`<div class="scroll"><table>
              ${d.events.map((e) => html`<tr><td class="muted">${when(e.createdAt)}</td><td>${e.fromStatus ?? "·"} → ${e.toStatus}</td><td>${e.actor}</td><td>${e.reason ?? ""}</td></tr>`)}
            </table></div>`,
          )}`,
      );
    });

    scope.post("/candidates/:id/caption", async (req, reply) => {
      const { id } = req.params as { id: string };
      return act(reply, `/candidates/${id}`, "Caption saved.", () => setCaption(ctx(req), id, ((req.body ?? {}) as Form).caption ?? ""));
    });

    scope.post("/candidates/:id/decision", async (req, reply) => {
      const { id } = req.params as { id: string };
      const form = (req.body ?? {}) as Form;
      const labels: Record<string, string> = { approve: "Approved.", needs_edit: "Sent back for edits.", reject: "Rejected.", hold: "On hold." };
      const target = form.decision === "hold" ? `/candidates/${id}` : "/review";
      try {
        await decideCandidate(ctx(req), id, { decision: form.decision ?? "", notes: form.notes, overrideFailedChecks: form.override === "yes" });
        return back(reply, target, { ok: labels[form.decision ?? ""] ?? "Done." });
      } catch (err) {
        const msg = errorMessage(err);
        if (msg === undefined) throw err;
        return back(reply, `/candidates/${id}`, { error: msg });
      }
    });

    scope.post("/candidates/:id/posts", async (req, reply) => {
      const { id } = req.params as { id: string };
      const f = (req.body ?? {}) as Form;
      return act(reply, `/candidates/${id}`, "Post recorded.", () =>
        recordPost(ctx(req), id, {
          platform: f.platform ?? "",
          url: f.url ?? "",
        }),
      );
    });

    scope.post("/candidates/:id/mark-posted", async (req, reply) => {
      const { id } = req.params as { id: string };
      return act(reply, `/candidates/${id}`, "Marked posted.", () => markPosted(ctx(req), id));
    });

    // --- posting -------------------------------------------------------------------------

    scope.get("/posts", async (req, reply) => {
      const rows = await candidatesByStatus(db, ["approved", "exporting", "ready_to_post", "posted"]);
      const { queue } = await postQueue(db);
      const titleOf = new Map(rows.map((r) => [r.clip.id, r]));
      const group = (s: string) => rows.filter((r) => r.clip.status === s);
      const section = (title: string, items: typeof rows, note: string, open = false) =>
        fold(
          `${title} (${items.length})`,
          html`${items.length ? "" : html`<p class="muted">${note}</p>`}
          ${items.map(({ clip, campaign }) => html`<p><a href="/candidates/${clip.id}">${clip.title ?? clip.opusclipClipId}</a> <span class="muted">· ${campaign.title} · ${seconds(clip.durationMs)}</span></p>`)}`,
          { open: open && items.length > 0 },
        );
      return view(
        req,
        reply,
        "Posting",
        html`<h1>Posting</h1>
          <p class="muted">Nothing is scheduled ahead. Say <strong>"post next"</strong> to the operator when you're ready to submit on Whop within 30 minutes; it posts the first clip in the queue.</p>
          ${fold(
            `Queue (${queue.length})`,
            queue.length
              ? html`<ol>${queue.map((q) => {
                  const r = titleOf.get(q.candidateId);
                  return html`<li><a href="/candidates/${q.candidateId}">${q.title ?? q.candidateId}</a> <span class="muted">· ${r?.campaign.title ?? ""} · ${r ? seconds(r.clip.durationMs) : ""}${q.packaged ? "" : " · not packaged yet"}</span></li>`;
                })}</ol>`
              : html`<p class="muted">Empty. Approve clips on the review queue and they line up here.</p>`,
            { open: true },
          )}
          ${section("Ready to post", group("ready_to_post"), "Nothing packaged yet.")}
          ${section("Approved, being exported and packaged", [...group("approved"), ...group("exporting")], "None.")}
          ${section("Posted", group("posted"), "None yet.")}`,
      );
    });
  });
}
