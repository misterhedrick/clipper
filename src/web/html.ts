// Tiny server-side HTML helpers. Every interpolated value is escaped unless it is
// already Html, because most of what these pages show (clip titles, captions,
// briefs, reasons) was written by third parties or by an AI.

export class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

type Value = Html | string | number | boolean | null | undefined | Value[];

function render(v: Value): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let out = strings[0]!;
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1]!;
  });
  return new Html(out);
}

/** Only http(s) URLs are ever put in href/src attributes. */
export const safeUrl = (u: string | null | undefined): string | undefined => {
  if (!u) return undefined;
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

export const when = (at: Date | string | null | undefined) =>
  at ? new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";

export const seconds = (ms: number | null | undefined) => (ms === null || ms === undefined ? "?" : `${(ms / 1000).toFixed(1)}s`);

export function badge(outcome: string): Html {
  const tone = outcome === "pass" ? "ok" : outcome === "fail" ? "bad" : "warn";
  return html`<span class="badge ${tone}">${outcome.replace(/_/g, " ")}</span>`;
}

export function page(opts: { title: string; reviewer?: string; flash?: { ok?: string; error?: string }; body: Html }): string {
  const nav = opts.reviewer
    ? html`<nav>
        <a href="/">Overview</a><a href="/campaigns">Campaigns</a><a href="/review">Review queue</a><a href="/posts">Posting</a>
        <form method="post" action="/logout" class="inline"><span class="muted">${opts.reviewer}</span> <button class="link">Sign out</button></form>
      </nav>`
    : "";
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · Clipper review</title>
<style>
  :root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --card: #fff; --accent: #2563eb;
          --ok: #15803d; --ok-bg: #dcfce7; --bad: #b91c1c; --bad-bg: #fee2e2; --warn: #a16207; --warn-bg: #fef9c3; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --card: #292524; --accent: #60a5fa;
            --ok: #86efac; --ok-bg: #14532d; --bad: #fca5a5; --bad-bg: #7f1d1d; --warn: #fde68a; --warn-bg: #713f12; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 1000px; margin: 0 auto; padding: 16px; }
  nav { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--card); }
  nav form { margin-left: auto; }
  a { color: var(--accent); }
  h1 { font-size: 1.5rem; margin: 8px 0 16px; } h2 { font-size: 1.15rem; margin: 24px 0 8px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin: 12px 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
  .muted { color: var(--muted); }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: .8rem; margin: 2px 4px 2px 0; }
  .ok { color: var(--ok); background: var(--ok-bg); } .bad { color: var(--bad); background: var(--bad-bg); } .warn { color: var(--warn); background: var(--warn-bg); }
  .flash { padding: 10px 14px; border-radius: 6px; margin: 12px 0; }
  table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .scroll { overflow-x: auto; }
  pre, textarea { font: 13px/1.4 ui-monospace, monospace; }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--bg); padding: 8px; border-radius: 6px; margin: 0; }
  textarea, input, select { width: 100%; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
  label { display: block; margin: 8px 0 4px; font-weight: 600; } label.check { font-weight: normal; display: flex; gap: 8px; align-items: center; }
  label.check input { width: auto; }
  button { padding: 8px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--accent); color: #fff; cursor: pointer; font: inherit; margin-top: 8px; }
  button.secondary { background: var(--card); color: var(--fg); } button.danger { background: var(--bad); }
  button.link { background: none; border: none; color: var(--accent); padding: 0; margin: 0; }
  form.inline { display: inline; }
  video { width: 100%; max-height: 70vh; background: #000; border-radius: 6px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
</head>
<body>
${nav}
<main>
${opts.flash?.ok ? html`<div class="flash ok" role="status">${opts.flash.ok}</div>` : ""}
${opts.flash?.error ? html`<div class="flash bad" role="alert">${opts.flash.error}</div>` : ""}
${opts.body}
</main>
</body>
</html>`.value;
}
