import type { mountEarnKnight } from "./scene";
import "./style.css";

export function mountEarnHero(host: HTMLElement) {
  host.classList.add("turret-earn-knight");
  host.dataset.earnKnight = "loading";
  host.innerHTML = `<div class="turret-earn-knight-loader" role="status"><svg viewBox="0 0 524 524" width="54" height="54" fill="currentColor" aria-hidden="true"><path d="M21 0h108v86h74V0h117v86h75V0h108v524H303V378h-82v146H21Z"/></svg><span class="turret-knight-sr">Loading knight animation</span></div><canvas role="img" aria-label="Turret's little knight mascot greeting lenders" aria-hidden="true"></canvas><button type="button" class="turret-earn-knight-pause" aria-label="Pause knight animation" hidden><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5 3v10M11 3v10" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>`;
  const canvas = host.querySelector("canvas")!;
  const button = host.querySelector("button")!;
  const loader = host.querySelector<HTMLElement>(".turret-earn-knight-loader")!;
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  let runtime: ReturnType<typeof mountEarnKnight> | undefined;
  let disposed = false, paused = false, ready = false;
  const motion = () => { runtime?.setMotion(paused, preference.matches); button.hidden = !ready || preference.matches; };
  const failed = () => {
    if (disposed) return;
    ready = false; host.dataset.earnKnight = "unavailable"; canvas.setAttribute("aria-hidden", "true");
    loader.removeAttribute("role"); loader.querySelector("span")!.textContent = "Turret"; button.hidden = true;
  };
  const timeout = window.setTimeout(failed, 10000);
  const toggle = () => {
    paused = !paused; button.setAttribute("aria-label", `${paused ? "Play" : "Pause"} knight animation`);
    button.querySelector("path")!.setAttribute("d", paused ? "M5 3l7 5-7 5Z" : "M5 3v10M11 3v10");
    motion();
  };
  button.addEventListener("click", toggle);
  preference.addEventListener("change", motion);
  void import("./scene").then(({ mountEarnKnight }) => {
    if (disposed) return;
    runtime = mountEarnKnight(canvas, () => {
      if (disposed) return;
      window.clearTimeout(timeout); ready = true; host.dataset.earnKnight = "ready";
      canvas.removeAttribute("aria-hidden"); motion();
    }, failed);
    motion();
  }).catch(failed);
  return () => {
    disposed = true; window.clearTimeout(timeout); runtime?.dispose();
    button.removeEventListener("click", toggle); preference.removeEventListener("change", motion);
    host.replaceChildren();
  };
}
