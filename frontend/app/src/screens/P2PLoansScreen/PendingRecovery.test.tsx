// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Deployment } from "../../p2p/client";
import { savePending } from "../../p2p/pending-transactions";
import { PendingRecovery } from "./PendingRecovery";
const account = `0x${"1".repeat(40)}` as const;
const other = `0x${"2".repeat(40)}` as const;
const market = { address: `0x${"3".repeat(40)}`, chainId: 31337, version: 3 } as Deployment;
const hash = `0x${"a".repeat(64)}` as const;
beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); });
afterEach(cleanup);
test("offers status retry and validates a supplied replacement without broadcasting", () => {
  savePending(`turret:p2p:pending:${market.chainId}:${market.address}:${account}`, hash);
  const recover = vi.fn().mockResolvedValue(undefined);
  render(<PendingRecovery account={account} markets={[market]} disabled={false} onRecover={recover} />);
  fireEvent.click(screen.getByText("Recover a saved transaction"));
  fireEvent.click(screen.getByRole("button", { name: "Check saved transaction" }));
  expect(recover).toHaveBeenLastCalledWith(market.address, undefined);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "0x123" } });
  expect(screen.getByRole("button")).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: hash } });
  fireEvent.click(screen.getByRole("button"));
  expect(recover).toHaveBeenLastCalledWith(market.address, hash);
});
test("does not reveal another wallet's pending transaction", () => {
  savePending(`turret:p2p:pending:${market.chainId}:${market.address}:${account}`, hash);
  render(<PendingRecovery account={other} markets={[market]} disabled={false} onRecover={vi.fn()} />);
  expect(screen.queryByText("Recover a saved transaction")).not.toBeInTheDocument();
});
