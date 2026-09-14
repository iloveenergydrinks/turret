// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { mountEarnHero } from "./host";
import { enhanceEarnHeroes } from "./bootstrap";

const mock = vi.hoisted(() => ({ ready: () => {}, lost: () => {}, dispose: vi.fn(), motion: vi.fn(), fail: false }));
vi.mock("./scene", () => ({ mountEarnKnight: (_canvas: unknown, ready: () => void, lost: () => void) => {
  if (mock.fail) throw Error("No WebGL"); mock.ready = ready; mock.lost = lost;
  return { dispose: mock.dispose, setMotion: mock.motion };
} }));
function setup() {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const host = document.createElement("figure"); document.body.append(host); return host;
}
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.clearAllMocks(); mock.fail = false; });
test("logo waits for the first frame, pause freezes motion, and teardown disposes the renderer", async () => {
  const host = setup(), dispose = mountEarnHero(host); await vi.dynamicImportSettled();
  expect(host.dataset.earnKnight).toBe("loading"); expect(host.querySelector("img")).toBeNull();
  mock.ready(); expect(host.dataset.earnKnight).toBe("ready");
  host.querySelector("button")!.click(); expect(mock.motion).toHaveBeenLastCalledWith(true, false);
  mock.lost(); expect(host.dataset.earnKnight).toBe("unavailable");
  dispose(); expect(mock.dispose).toHaveBeenCalledOnce();
});
test("unsupported WebGL leaves a static brand mark", async () => {
  const host = setup(); mock.fail = true; const dispose = mountEarnHero(host); await vi.dynamicImportSettled();
  expect(host.dataset.earnKnight).toBe("unavailable"); expect(host.querySelector("button")!.hidden).toBe(true); dispose();
});
test("reduced motion keeps the mascot still and hides the motion control", async () => {
  const host = setup();
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const dispose = mountEarnHero(host); await vi.dynamicImportSettled(); mock.ready();
  expect(mock.motion).toHaveBeenLastCalledWith(false, true);
  expect(host.querySelector("button")!.hidden).toBe(true); dispose();
});
test("client navigation mounts once, disposes on leaving, and mounts again when returning", async () => {
  setup().remove();
  const stop = enhanceEarnHeroes();
  document.body.innerHTML = '<div class="dockyard-earn-index"><header class="dockyard-earn-index-header"><h1>Earn</h1></header></div>';
  await vi.dynamicImportSettled(); expect(document.querySelectorAll("[data-earn-knight]")).toHaveLength(1);
  document.querySelector("header")!.append(document.createElement("p"));
  await vi.dynamicImportSettled(); expect(document.querySelectorAll("[data-earn-knight]")).toHaveLength(1);
  document.body.replaceChildren(); await vi.dynamicImportSettled(); expect(mock.dispose).toHaveBeenCalledOnce();
  document.body.innerHTML = '<div class="dockyard-earn-index"><header class="dockyard-earn-index-header"></header></div>';
  await vi.dynamicImportSettled(); expect(document.querySelectorAll("[data-earn-knight]")).toHaveLength(1); stop();
});
