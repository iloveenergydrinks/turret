// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { HeaderNavigation } from "./HeaderNavigation";

afterEach(cleanup);

function setup() {
  render(<>
    <HeaderNavigation><a href="#markets">Markets</a><a href="#blog">Blog</a></HeaderNavigation>
    <button type="button">Connect</button>
  </>);
  return userEvent.setup();
}

describe("mobile header navigation", () => {
  it("exposes the disclosure state and opens both navigation links", async () => {
    const user = setup();
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", screen.getByRole("navigation").id);
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("navigation")).toHaveAttribute("data-open", "true");
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("opens by keyboard, closes with Escape and restores focus", async () => {
    const user = setup();
    await user.tab();
    await user.keyboard("{Enter}");
    await user.tab();
    expect(screen.getByRole("link", { name: "Markets" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveFocus();
    expect(screen.getByRole("navigation")).toHaveAttribute("data-open", "false");
  });

  it("dismisses when clicking outside, without blocking the wallet control", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("navigation")).toHaveAttribute("data-open", "false");
    expect(screen.getByRole("button", { name: "Connect" })).toHaveFocus();
  });

  it("dismisses when following a navigation link", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await user.click(screen.getByRole("link", { name: "Markets" }));
    expect(screen.getByRole("navigation")).toHaveAttribute("data-open", "false");
  });
});
