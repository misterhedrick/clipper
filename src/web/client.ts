// The review app's only script, served at /app.js (the CSP allows scripts from our own origin and nowhere
// else, never inline). Every page works without it; it only smooths the installed home-screen app:
//  - pull down at the top of a page to refresh it, and the page refreshes itself when you come back to the
//    app after a minute away (unless you were typing something);
//  - the ☰ menu closes when you tap outside it, pick a link or press Escape;
//  - a button you tapped shows it's working and can't be tapped twice.
// Plain browser JavaScript, no build step: it ships as this string.

export const CLIENT_JS = String.raw`(() => {
  "use strict";
  const STALE_MS = 60000;
  const PULL_PX = 70;

  const refreshUrl = () => {
    const link = document.querySelector("a.refresh");
    return link ? link.getAttribute("href") || location.pathname : location.pathname + location.search;
  };
  const refresh = () => {
    document.documentElement.classList.add("refreshing");
    location.replace(refreshUrl());
  };

  // Something typed and not yet submitted: don't throw it away with a refresh.
  const dirty = () =>
    Array.from(document.querySelectorAll("textarea, input:not([type=hidden]):not([type=password]), select")).some((el) =>
      el.type === "checkbox" || el.type === "radio" ? el.checked !== el.defaultChecked
        : el.tagName === "SELECT" ? Array.from(el.options).some((o) => o.selected !== o.defaultSelected)
        : el.value !== el.defaultValue,
    );

  document.addEventListener("click", (e) => {
    const refreshLink = e.target.closest("a.refresh");
    if (refreshLink) { e.preventDefault(); refresh(); return; }
    const menu = document.querySelector("details.menu[open]");
    if (menu && (!menu.contains(e.target) || e.target.closest(".menu-panel a"))) menu.open = false;
  });
  document.addEventListener("keydown", (e) => {
    const menu = document.querySelector("details.menu[open]");
    if (e.key === "Escape" && menu) { menu.open = false; menu.querySelector("summary").focus(); }
  });

  // One tap per submit: the button shows it's busy until the next page loads.
  document.addEventListener("submit", (e) => {
    if (e.defaultPrevented) return;
    const button = e.submitter;
    if (!button || button.disabled) return;
    if (e.target.dataset.submitting) { e.preventDefault(); return; }
    e.target.dataset.submitting = "1";
    // Disable after the submit has picked up the button's own name/value.
    setTimeout(() => { button.disabled = true; button.classList.add("busy"); }, 0);
  });
  // Coming back with the Back button restores the old page from cache: undo the busy state.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    document.querySelectorAll("form[data-submitting]").forEach((f) => delete f.dataset.submitting);
    document.querySelectorAll("button.busy").forEach((b) => { b.disabled = false; b.classList.remove("busy"); });
    document.documentElement.classList.remove("refreshing");
  });

  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > STALE_MS && document.querySelector("a.refresh") && !dirty()) refresh();
  });

  // Pull to refresh. Installed web apps get no browser pull-to-refresh, so draw our own.
  const pull = document.createElement("div");
  pull.className = "pull";
  pull.setAttribute("aria-hidden", "true");
  pull.textContent = "↻";
  let startY = null;
  let dist = 0;
  const reset = () => { startY = null; dist = 0; pull.style.transform = ""; pull.classList.remove("ready", "pulling"); };
  document.addEventListener("touchstart", (e) => {
    startY = window.scrollY <= 0 && e.touches.length === 1 && document.querySelector("a.refresh") ? e.touches[0].clientY : null;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    dist = Math.max(0, e.touches[0].clientY - startY);
    if (window.scrollY > 0 || dist === 0) { pull.classList.remove("pulling"); return; }
    if (!pull.isConnected) document.body.append(pull);
    pull.classList.add("pulling");
    pull.classList.toggle("ready", dist > PULL_PX);
    pull.style.transform = "translateY(" + Math.min(dist, PULL_PX * 1.5) + "px) rotate(" + dist * 3 + "deg)";
  }, { passive: true });
  document.addEventListener("touchend", () => {
    if (startY !== null && dist > PULL_PX && window.scrollY <= 0) refresh();
    else reset();
  });
  document.addEventListener("touchcancel", reset);
})();
`;
