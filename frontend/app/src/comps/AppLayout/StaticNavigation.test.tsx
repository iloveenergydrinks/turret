// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
vi.mock("@/src/env", () => ({ CHAIN_ID: 4663, CHAIN_NAME: "Robinhood Chain" }));
vi.mock("@/src/comps/Logo/Logo", () => ({ Logo: () => <span>turret.</span> }));
vi.mock("./AccountButton", () => ({ AccountButton: () => <button>Connect</button> }));
vi.mock("next/navigation", () => ({ usePathname: () => "/earn" }));
vi.mock("next/link", () => ({
  default: () => {
    throw new Error("Cross-bundle client navigation must not prefetch RSC");
  },
}));
import { PreviewTopBar } from "./PreviewTopBar";
import { TopBar } from "./TopBar";
afterEach(cleanup);
test.each([TopBar, PreviewTopBar])("header uses document links across static releases (%#)", (Header) => {
  render(<Header />);
  expect(screen.getByRole("link", { name: /^Borrow$/ })).toHaveAttribute("href", "/");
  expect(screen.getByRole("link", { name: /^Earn$/ })).toHaveAttribute("href", "/earn");
  expect(screen.getByRole("link", { name: /^Portfolio$/ })).toHaveAttribute("href", "/portfolio");
  expect(screen.getByRole("link", { name: /^Earn$/ })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: /^Borrow$/ })).not.toHaveAttribute("aria-current");
  expect(screen.getByRole("link", { name: "Turret home" })).toHaveAttribute("href", "/");
});
