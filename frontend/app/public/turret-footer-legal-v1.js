// Shared footer links for independently released application bundles.
(() => {
  const links = [["Terms", "/terms"], ["Risk", "https://docs.turret.capital/platform/risks"]];
  function updateFooters() {
    document.querySelectorAll(".rusd-footer-links, .blog-footer > div").forEach((footer) => {
      if ((footer.closest('footer') || footer).querySelector('a[href="https://x.com/turret_capital"]')) return;
      const link = document.createElement("a");
      link.className = "turret-x-link";
      link.href = "https://x.com/turret_capital";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = "@turret_capital on X";
      link.setAttribute("aria-label", "Turret on X (opens in a new tab)");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      for (const [key, value] of Object.entries({ "aria-hidden": "true", fill: "currentColor", height: "18", width: "18", viewBox: "0 0 24 24" })) svg.setAttribute(key, value);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.835L0 1.154h7.594l5.243 6.932 6.064-6.933Zm-1.29 19.49h2.039L6.487 3.24H4.3l13.311 17.403Z");
      svg.appendChild(path);
      link.appendChild(svg);
      footer.prepend(link);
    });
    document.querySelectorAll(".rusd-footer-links").forEach((footer) => {
      for (const [label, href] of links) {
        if ([...footer.querySelectorAll("a")].some((link) => link.getAttribute("href") === href)) continue;
        const link = document.createElement("a");
        link.className = "rusd-text-link";
        link.href = href;
        link.textContent = label;
        footer.appendChild(link);
      }
    });
  }
  function start() {
    const style = document.createElement("style");
    style.textContent = ".turret-x-link{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:36px;height:36px;color:inherit;border-radius:6px}.turret-x-link:hover{background:rgb(127 127 127 / 12%)}.turret-x-link:focus-visible{outline:2px solid currentColor;outline-offset:3px}";
    document.head.appendChild(style);
    updateFooters();
    new MutationObserver(updateFooters).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
})();
