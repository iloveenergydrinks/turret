import { mountEarnHero } from "./host";

/** Progressive enhancement for the published Next shell, including client-side navigation. */
export function enhanceEarnHeroes(root: Document = document) {
  const active = new Map<HTMLElement, () => void>();
  const sync = () => {
    active.forEach((dispose, host) => { if (!host.isConnected) { dispose(); active.delete(host); } });
    root.querySelectorAll<HTMLElement>(".dockyard-earn-index > .dockyard-earn-index-header").forEach(header => {
      if (header.querySelector("[data-earn-knight]")) return;
      const host = root.createElement("figure");
      host.dataset.earnKnight = "loading"; header.append(host);
      active.set(host, mountEarnHero(host));
    });
  };
  const observer = new MutationObserver(sync);
  observer.observe(root.body, { childList: true, subtree: true });
  sync();
  return () => { observer.disconnect(); active.forEach((dispose, host) => { dispose(); host.remove(); }); active.clear(); };
}
