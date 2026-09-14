// @vitest-environment jsdom
import type { ReactNode } from "react";

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountButton } from "./AccountButton";
import { defaultWalletAvatar, renderWalletAvatar } from "../../../../../shared/wallet-avatar.mjs";

const wallet = vi.hoisted(() => ({
  address: "0x8D91111111111111111111111111111111110086",
  chain: { id: 46630, unsupported: false } as { id: number; unsupported: boolean } | undefined,
  isConnected: true,
  isConnecting: false,
  ensName: undefined as string | undefined,
  show: vi.fn(),
}));
const switchChain = vi.hoisted(() => vi.fn());

vi.mock("connectkit", () => ({
  ConnectKitButton: { Custom: ({ children }: { children: (props: typeof wallet) => ReactNode }) => children(wallet) },
}));
vi.mock("wagmi", () => ({ useSwitchChain: () => ({ switchChain, chains: [{ id: 46630 }] }) }));
vi.mock("@react-spring/web", () => ({
  a: { div: "div" },
  useTransition: (status: unknown) => (renderState: (style: object, state: unknown) => ReactNode) => renderState({}, status),
}));
vi.mock("@turret/uikit", async (importOriginal) => ({
  ...await importOriginal<object>(),
  ShowAfter: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.clearAllMocks();
  wallet.chain = { id: 46630, unsupported: false };
  wallet.isConnected = true;
  wallet.isConnecting = false;
  wallet.ensName = undefined;
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

describe("Turret account control", () => {
  it("renders the same generated avatar as P2P while the profile loads", () => {
    render(<AccountButton />);
    const avatar = screen.getByRole("button").querySelector("img.wallet-avatar");
    expect(avatar).toHaveAttribute("src", `data:image/svg+xml,${encodeURIComponent(renderWalletAvatar(defaultWalletAvatar(wallet.address)))}`);
    expect(avatar).toHaveAttribute("width", "22");
    expect(avatar).toHaveAttribute("height", "22");
  });

  it("loads the saved profile picture into the wallet button", async () => {
    const previousAddress = wallet.address;
    wallet.address = "0x1111111111111111111111111111111111111111";
    const hash = "a".repeat(64);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      address: wallet.address.toLowerCase(), avatar: { kind: "image", version: 1, hash }, revision: 1, updatedAt: 1,
    }) }));
    try {
      render(<AccountButton />);
      await waitFor(() => expect(screen.getByRole("button").querySelector("img.wallet-avatar"))
        .toHaveAttribute("src", `/api/profiles/avatar/${hash}.png`));
      expect(fetch).toHaveBeenCalledWith(`/api/profiles/${wallet.address.toLowerCase()}`, expect.any(Object));
    } finally {
      wallet.address = previousAddress;
    }
  });

  it("shows a readable address and opens the wallet menu", async () => {
    render(<AccountButton />);
    const button = screen.getByRole("button", { name: `Open wallet menu for ${wallet.address}` });
    expect(button).toHaveTextContent("0x8D91…0086");
    expect(button).toHaveAttribute("title", wallet.address);
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveAttribute("type", "button");
    await userEvent.click(button);
    expect(wallet.show).toHaveBeenCalledOnce();
  });

  it("supports keyboard activation", async () => {
    render(<AccountButton />);
    await userEvent.tab();
    expect(screen.getByRole("button")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(wallet.show).toHaveBeenCalledOnce();
  });

  it("keeps long ENS names in the bounded label and the full address available", () => {
    wallet.ensName = "a-very-long-dockyard-account-name.eth";
    render(<AccountButton />);
    expect(screen.getByText(wallet.ensName)).toHaveClass("dockyard-wallet-label");
    expect(screen.getByRole("button")).toHaveAttribute("title", wallet.address);
  });

  it("opens the connect dialog when disconnected", async () => {
    wallet.isConnected = false;
    render(<AccountButton />);
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(wallet.show).toHaveBeenCalledOnce();
  });

  it("prevents repeated connection requests while connecting", async () => {
    wallet.isConnected = false;
    wallet.isConnecting = true;
    render(<AccountButton />);
    const button = screen.getByRole("button", { name: "Connecting…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(wallet.show).not.toHaveBeenCalled();
  });

  it.each([undefined, { id: 1, unsupported: true }])("switches an unsupported chain (%j)", async (chain) => {
    wallet.chain = chain;
    render(<AccountButton />);
    await userEvent.click(screen.getByRole("button", { name: "Wrong network" }));
    expect(switchChain).toHaveBeenCalledWith({ chainId: 46630 });
    expect(wallet.show).not.toHaveBeenCalled();
  });
});
