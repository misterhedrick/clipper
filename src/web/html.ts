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

/**
 * A list, table or long block collapsed behind a one-line summary, so a page
 * fits on a phone without scrolling (the reviewer's request, 2026-09-29).
 * `open` for the one section a person is most likely to act on.
 */
export function fold(summary: Html | string, body: Html | string, opts: { open?: boolean } = {}): Html {
  return html`<details class="fold"${opts.open ? html` open` : ""}><summary>${summary}</summary><div class="fold-body">${body}</div></details>`;
}

/** "11 of 12 passed", plus failed / to-check badges: the summary line for a list of checks. */
export function checkTally(results: [string, string][]): Html {
  const passed = results.filter(([, v]) => v === "pass").length;
  const failed = results.filter(([, v]) => v === "fail").length;
  const toCheck = results.length - passed - failed;
  return html`Checks: ${passed} of ${results.length} passed${failed ? html` <span class="badge bad">${failed} failed</span>` : ""}${toCheck ? html` <span class="badge warn">${toCheck} to check</span>` : ""}`;
}

const NAV_LINKS: [href: string, label: string][] = [
  ["/", "Overview"],
  ["/campaigns", "Campaigns"],
  ["/review", "Review queue"],
  ["/posts", "Posting"],
];

/** The current URL minus the one-shot flash params, so Refresh reloads the view without repeating its message. */
export function refreshHref(url: string): string {
  const u = new URL(url, "http://x");
  u.searchParams.delete("ok");
  u.searchParams.delete("error");
  return u.pathname + u.search;
}

// No JavaScript (the CSP allows none), so the mobile menu is a <details> and Refresh is a plain link:
// an installed home-screen app has no browser reload button or pull-to-refresh.
export function page(opts: { title: string; reviewer?: string; path?: string; flash?: { ok?: string; error?: string }; body: Html }): string {
  const here = opts.path ? new URL(opts.path, "http://x").pathname : undefined;
  const isHere = (href: string) => (href === "/" ? here === "/" : here === href || here?.startsWith(`${href}/`));
  const links = NAV_LINKS.map(([href, label]) => html`<a href="${href}"${isHere(href) ? html` class="here" aria-current="page"` : ""}>${label}</a>`);
  const signOut = html`<form method="post" action="/logout" class="inline"><span class="muted">${opts.reviewer ?? ""}</span> <button class="link">Sign out</button></form>`;
  const nav = opts.reviewer
    ? html`<nav>
        <details class="menu">
          <summary aria-label="Menu">☰ Menu</summary>
          <div class="menu-panel">${links}${signOut}</div>
        </details>
        <div class="nav-links">${links}</div>
        <a class="refresh" href="${opts.path ?? ""}" aria-label="Refresh">↻ Refresh</a>
        <div class="nav-signout">${signOut}</div>
      </nav>`
    : "";
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · Clipper review</title>
<style>
  :root { --bg: #f8f6f3; --fg: #1f1f1f; --muted: #6b6b6b; --line: #e0dcd8; --card: #fff; --accent: #3b82f6; --accent-dark: #1e40af;
          --ok: #059669; --ok-bg: #ecfdf5; --bad: #dc2626; --bad-bg: #fef2f2; --warn: #d97706; --warn-bg: #fffbeb;
          --shadow: 0 1px 3px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.05); --shadow-sm: 0 1px 2px rgba(0,0,0,0.05); }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1a1a1a; --fg: #f5f5f5; --muted: #9ca3af; --line: #3f3f3f; --card: #262626; --accent: #60a5fa; --accent-dark: #3b82f6;
            --ok: #10b981; --ok-bg: #064e3b; --bad: #f87171; --bad-bg: #7f1d1d; --warn: #fbbf24; --warn-bg: #78350f;
            --shadow: 0 1px 3px rgba(0,0,0,0.3), 0 4px 12px rgba(0,0,0,0.2); --shadow-sm: 0 1px 2px rgba(0,0,0,0.2); }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 1000px; margin: 0 auto; padding: 12px; }
  @media (min-width: 640px) { main { padding: 20px; } }
  nav { position: sticky; top: 0; z-index: 10; display: flex; gap: 12px; align-items: center; padding: 8px 12px; padding-top: max(8px, env(safe-area-inset-top)); border-bottom: 1px solid var(--line); background: var(--card); font-size: 15px; box-shadow: var(--shadow-sm); }
  nav a { color: var(--accent); font-weight: 500; transition: color 0.2s; white-space: nowrap; }
  nav a:hover { color: var(--accent-dark); }
  nav a.here { color: var(--fg); font-weight: 700; }
  nav button { white-space: nowrap; }
  nav a.refresh { margin-left: auto; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; }
  nav a.refresh:hover { text-decoration: none; background: var(--bg); }
  /* Phones: links and Sign out live in the ☰ menu; Refresh stays in the bar. */
  details.menu { background: none; border: none; padding: 0; margin: 0; }
  details.menu > summary { list-style: none; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; color: var(--fg); }
  details.menu > summary::-webkit-details-marker { display: none; }
  details.menu[open] > summary { background: var(--bg); }
  .menu-panel { position: absolute; left: 0; right: 0; top: 100%; display: flex; flex-direction: column; background: var(--card); border-bottom: 1px solid var(--line); box-shadow: var(--shadow); }
  .menu-panel a, .menu-panel form { padding: 14px 16px; border-top: 1px solid var(--line); font-size: 16px; }
  .menu-panel a.here { background: var(--bg); }
  .nav-links, .nav-signout { display: none; }
  @media (min-width: 640px) {
    nav { gap: 20px; padding: 10px 20px; }
    details.menu { display: none; }
    .nav-links { display: flex; gap: 20px; }
    .nav-signout { display: block; }
    nav a.refresh { margin-left: auto; }
  }
  a { color: var(--accent); text-decoration: none; transition: color 0.2s; }
  a:hover { color: var(--accent-dark); text-decoration: underline; }
  h1 { font-size: 1.5rem; font-weight: 700; margin: 12px 0 16px; letter-spacing: -0.5px; }
  @media (min-width: 640px) { h1 { font-size: 2rem; margin: 16px 0 20px; } }
  h2 { font-size: 1.1rem; font-weight: 600; margin: 16px 0 12px; letter-spacing: -0.25px; }
  @media (min-width: 640px) { h2 { font-size: 1.25rem; margin: 20px 0 12px; } }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin: 10px 0; box-shadow: var(--shadow); transition: box-shadow 0.2s, transform 0.2s; }
  .card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.12), 0 6px 16px rgba(0,0,0,0.08); }
  @media (min-width: 640px) { .card { border-radius: 10px; padding: 18px; margin: 14px 0; } }
  .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
  @media (min-width: 768px) { .grid { grid-template-columns: repeat(2, 1fr); gap: 16px; } }
  @media (min-width: 1024px) { .grid { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); } }
  .muted { color: var(--muted); }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: .8rem; font-weight: 600; margin: 4px 6px 4px 0; letter-spacing: 0.3px; }
  @media (min-width: 640px) { .badge { padding: 4px 12px; font-size: .85rem; } }
  .ok { color: #fff; background: linear-gradient(135deg, var(--ok), #059669); }
  .bad { color: #fff; background: linear-gradient(135deg, var(--bad), #b91c1c); }
  .warn { color: #000; background: linear-gradient(135deg, var(--warn), #d97706); }
  .flash { padding: 12px 16px; border-radius: 8px; margin: 10px 0; font-size: 14px; font-weight: 500; border-left: 4px solid; }
  .flash.ok { border-color: var(--ok); background: var(--ok-bg); color: var(--ok); }
  .flash.bad { border-color: var(--bad); background: var(--bad-bg); color: var(--bad); }
  @media (min-width: 640px) { .flash { padding: 14px 18px; margin: 14px 0; font-size: 15px; } }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  @media (min-width: 640px) { table { font-size: 15px; } }
  thead { background: var(--bg); font-weight: 600; }
  td, th { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  @media (min-width: 640px) { td, th { padding: 12px 10px; } }
  tbody tr:hover { background: var(--bg); }
  .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  pre, textarea { font: 13px/1.5 "Menlo", "Monaco", ui-monospace, monospace; }
  @media (min-width: 640px) { pre, textarea { font: 14px/1.6 "Menlo", "Monaco", ui-monospace, monospace; } }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--bg); padding: 12px; border-radius: 6px; margin: 8px 0; border: 1px solid var(--line); }
  textarea, input, select { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); font-size: 16px; transition: border-color 0.2s, box-shadow 0.2s; }
  textarea:focus, input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
  @media (min-width: 640px) { textarea, input, select { font-size: 15px; padding: 11px 13px; } }
  label { display: block; margin: 10px 0 6px; font-weight: 600; font-size: 14px; letter-spacing: 0.25px; }
  @media (min-width: 640px) { label { font-size: 15px; margin: 12px 0 6px; } }
  label.check { font-weight: normal; display: flex; gap: 10px; align-items: center; margin: 8px 0; }
  label.check input { width: auto; }
  button { padding: 10px 16px; border-radius: 6px; border: none; background: linear-gradient(135deg, var(--accent), var(--accent-dark)); color: #fff; cursor: pointer; font: inherit; font-weight: 600; margin-top: 10px; font-size: 14px; transition: transform 0.2s, box-shadow 0.2s; box-shadow: var(--shadow); }
  button:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3); }
  button:active { transform: translateY(0); }
  @media (min-width: 640px) { button { padding: 11px 18px; font-size: 15px; } }
  button.secondary { background: var(--card); color: var(--fg); border: 1px solid var(--line); box-shadow: var(--shadow-sm); }
  button.secondary:hover { background: var(--bg); box-shadow: var(--shadow); }
  button.danger { background: linear-gradient(135deg, var(--bad), #991b1b); }
  button.danger:hover { box-shadow: 0 4px 12px rgba(220, 38, 38, 0.3); }
  button.link { background: none; border: none; color: var(--accent); padding: 0; margin: 0; font-weight: 600; box-shadow: none; }
  button.link:hover { color: var(--accent-dark); }
  form.inline { display: inline; }
  video { width: 100%; max-height: 50vh; background: #000; border-radius: 8px; box-shadow: var(--shadow); }
  @media (min-width: 640px) { video { max-height: 70vh; border-radius: 10px; } }
  img { max-width: 100%; height: auto; display: block; border-radius: 6px; }
  @media (min-width: 640px) { img { border-radius: 8px; } }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  @media (min-width: 640px) { .actions { gap: 10px; } }
  .clip { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 12px; align-items: start; }
  @media (min-width: 640px) { .clip { grid-template-columns: 170px minmax(0, 1fr); gap: 20px; } }
  .clip-thumb img { width: 100%; aspect-ratio: 9 / 16; object-fit: cover; }
  .clip-thumb .muted { display: flex; align-items: center; justify-content: center; aspect-ratio: 9 / 16; border: 1px dashed var(--line); border-radius: 6px; font-size: 13px; }
  .clip-head { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; justify-content: space-between; }
  .clip-head h2 { margin: 0; overflow-wrap: anywhere; }
  .clip-meta, .checks, .verdict { overflow-wrap: anywhere; }
  .clip-meta { margin: 4px 0 10px; font-size: 14px; }
  .checks { list-style: none; padding: 0; margin: 10px 0; display: grid; grid-template-columns: 1fr; gap: 2px 16px; font-size: 14px; }
  @media (min-width: 900px) { .checks { grid-template-columns: repeat(2, 1fr); } }
  .checks li { display: flex; gap: 8px; align-items: baseline; line-height: 1.35; padding: 3px 0; }
  .checks .badge { margin: 0; flex: none; min-width: 3.4em; text-align: center; padding: 2px 8px; font-size: .75rem; }
  .verdict { border-left: 4px solid var(--line); background: var(--bg); border-radius: 6px; padding: 10px 12px; margin: 10px 0 0; font-size: 14px; }
  .verdict.ok { border-color: var(--ok); } .verdict.bad { border-color: var(--bad); } .verdict.warn { border-color: var(--warn); }
  .verdict.ok, .verdict.bad, .verdict.warn { color: var(--fg); background: var(--bg); }
  /* Review queue: each clip is one compact row that expands to its checks and notes. */
  details.qitem { background: var(--card); padding: 0; margin: 8px 0; }
  details.qitem > summary { list-style: none; display: flex; gap: 12px; align-items: center; padding: 10px 12px; color: var(--fg); font-weight: normal; }
  details.qitem > summary::-webkit-details-marker { display: none; }
  details.qitem > summary::after { content: "▾"; margin-left: auto; flex: none; color: var(--muted, #888); transition: transform .2s; }
  details.qitem[open] > summary::after { transform: rotate(180deg); }
  details.qitem > summary:hover { color: var(--fg); background: var(--bg); border-radius: 8px; }
  .qthumb { width: 40px; height: 71px; flex: none; object-fit: cover; border-radius: 4px; background: var(--bg); }
  .qmain { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .qtitle { font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
  .qmeta { font-size: 13px; overflow-wrap: anywhere; }
  .qtags { display: flex; flex-wrap: wrap; gap: 6px; }
  .qtags .badge { margin: 0; font-size: .72rem; padding: 2px 8px; }
  .qbody { padding: 0 12px 12px; border-top: 1px solid var(--line); }
  a.button { display: inline-block; padding: 9px 14px; border-radius: 6px; background: linear-gradient(135deg, var(--accent), var(--accent-dark)); color: #fff; font-weight: 600; text-decoration: none; font-size: 14px; }
  details { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 12px; margin: 10px 0; }
  @media (min-width: 640px) { details { border-radius: 8px; padding: 14px; } }
  summary { cursor: pointer; font-weight: 600; color: var(--accent); user-select: none; }
  summary:hover { color: var(--accent-dark); }
  /* Collapsed lists: one tap to open, a chevron that turns. */
  details.fold { background: var(--card); padding: 0; }
  details.fold > summary { list-style: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 12px 36px 12px 14px; position: relative; color: var(--fg); }
  details.fold > summary::-webkit-details-marker { display: none; }
  details.fold > summary::after { content: "▾"; position: absolute; right: 14px; top: 12px; color: var(--muted, #888); transition: transform .2s; }
  details.fold[open] > summary::after { transform: rotate(180deg); }
  details.fold > summary .badge { margin: 0; font-size: .72rem; padding: 2px 8px; }
  .fold-body { padding: 0 14px 12px; border-top: 1px solid var(--line); }
  .fold-body > .card, .fold-body > table { margin-top: 10px; }
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
