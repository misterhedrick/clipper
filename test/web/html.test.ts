import { describe, expect, it } from "vitest";
import { CLIENT_JS } from "../../src/web/client.js";
import { html, page, refreshHref } from "../../src/web/html.js";

describe("refreshHref", () => {
  it("keeps the path and filters but drops the one-shot flash", () => {
    expect(refreshHref("/review?status=approved&ok=Approved.&campaign=abc")).toBe("/review?status=approved&campaign=abc");
    expect(refreshHref("/campaigns/1?error=Nope")).toBe("/campaigns/1");
    expect(refreshHref("/")).toBe("/");
  });
});

describe("page nav", () => {
  it("has a menu with every link and Sign out, and a Refresh link to the current view", () => {
    const out = page({ title: "Review queue", reviewer: "alex", path: "/review?status=approved", body: html`<p>x</p>` });
    const menu = out.slice(out.indexOf('<details class="menu">'), out.indexOf("</details>"));
    for (const label of ["Overview", "Campaigns", "Review queue", "Posting", "Sign out"]) expect(menu).toContain(label);
    expect(out).toContain('<a class="refresh" href="/review?status=approved" aria-label="Refresh">');
    expect(menu).toContain('<a href="/review" class="here" aria-current="page">');
    // Only our own script file, never inline code (the CSP refuses inline scripts).
    expect(out.match(/<script[^>]*>/g)).toEqual(['<script src="/app.js" defer>']);
  });

  it("shows no nav when signed out", () => {
    expect(page({ title: "Sign in", body: html`` })).not.toContain("<nav>");
  });
});

describe("client script", () => {
  it("is valid JavaScript", () => {
    expect(() => new Function(CLIENT_JS)).not.toThrow();
  });
});
