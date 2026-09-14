// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TurretModel } from "./TurretModel";

const runtime = vi.hoisted(() => ({ ready: () => {}, lost: () => {}, fail: false, mounts: 0, themes: [] as string[] }));
vi.mock("./turret/scene", () => ({
  mountTurret: (_canvas: HTMLCanvasElement, ready: () => void, lost: () => void) => {
    runtime.mounts++;
    if (runtime.fail) throw new Error("WebGL unavailable");
    runtime.ready = ready;
    runtime.lost = lost;
    return { setMotion: vi.fn(), setTheme: (theme: string) => runtime.themes.push(theme), dispose: vi.fn() };
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  runtime.fail = false;
  runtime.mounts = 0; runtime.themes = [];
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("keeps the logo visible until the scene has rendered and removes the old picture", async () => {
  const view = render(<TurretModel />);
  await act(async () => {});
  expect(view.container.querySelector('[data-loading="true"]')).not.toBeNull();
  expect(view.container.querySelector('img')).toBeNull();
  act(() => runtime.ready());
  expect(view.container.querySelector('[data-loading="false"]')).not.toBeNull();
  expect(view.container.querySelector('canvas[data-ready="true"]')).not.toBeNull();
  act(() => runtime.lost());
  expect(view.container.querySelector('[data-loading="true"]')).toBeNull();
});

it("opens the website if WebGL is unavailable", async () => {
  runtime.fail = true;
  const view = render(<TurretModel />);
  await act(async () => {});
  expect(view.container.querySelector('[data-loading="false"]')).not.toBeNull();
});

it("changes themes without recreating WebGL or reopening the page loader", async () => {
  const view = render(<TurretModel theme="p2p" />);
  await act(async () => {});
  act(() => runtime.ready());
  const canvas = view.container.querySelector("canvas");
  view.rerender(<TurretModel theme="nfts" />);
  view.rerender(<TurretModel theme="pools" />);
  expect(runtime.mounts).toBe(1);
  expect(runtime.themes).toEqual(["nfts", "pools"]);
  expect(view.container.querySelector("canvas")).toBe(canvas);
  expect(view.container.querySelector('[data-loading="true"]')).toBeNull();
});

it("releases a stalled loader and can still reveal a late scene", async () => {
  const view = render(<TurretModel />);
  await act(async () => {});
  act(() => vi.advanceTimersByTime(10000));
  expect(view.container.querySelector('[data-loading="false"]')).not.toBeNull();
  act(() => runtime.ready());
  expect(view.container.querySelector('canvas[data-ready="true"]')).not.toBeNull();
});
