// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { RewardCounter } from "./RewardCounter";

afterEach(cleanup);
it("shows exact six-decimal balances and rolls only changed digits on increases", () => {
  const view = render(<RewardCounter value={999999n} />);
  expect(screen.getByText("0.999999")).toHaveTextContent("0.999999");
  expect(view.container.querySelector(".turret-reward-digit-in")).toBeNull();
  view.rerender(<RewardCounter value={1000000n} />);
  expect(screen.getByText("1.000000")).toHaveTextContent("1.000000");
  expect(view.container.querySelectorAll(".turret-reward-digit-in")).toHaveLength(7);
  view.rerender(<RewardCounter value={1000001n} />);
  expect(view.container.querySelectorAll(".turret-reward-digit-in")).toHaveLength(1);
});
it("immediately resets on claims, corrections and account changes", () => {
  const view = render(<RewardCounter key="alice" value={46411n} />);
  view.rerender(<RewardCounter key="alice" value={1n} />);
  expect(screen.getByText("0.000001")).toHaveTextContent("0.000001");
  expect(view.container.querySelector(".turret-reward-digit-in")).toBeNull();
  view.rerender(<RewardCounter key="bob" value={888888n} />);
  expect(view.container.querySelector(".turret-reward-digit-in")).toBeNull();
});
it("preserves bigint precision above the safe integer limit", () => {
  render(<RewardCounter value={9007199254740993123456n} />);
  expect(screen.getByText("9,007,199,254,740,993.123456")).toHaveTextContent("9,007,199,254,740,993.123456");
});
