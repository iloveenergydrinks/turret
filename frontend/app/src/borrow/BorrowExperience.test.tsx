// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BorrowExperience } from "./BorrowExperience";
import { BorrowPageHeader } from "./BorrowPageHeader";

vi.mock("./TurretModel", () => ({ TurretModel: ({theme}: {theme: string}) => <canvas data-testid="hero" data-theme={theme} /> }));
vi.mock("../comps/HowBorrowingWorks/HowBorrowingWorks", () => ({HowBorrowingWorks: () => null, HowP2PWorks: () => null}));
vi.mock("../comps/AppLayout/AccountButton", () => ({AccountButton: () => null}));
vi.mock("../p2p/P2PAppLayout", () => ({P2PAppLayout: ({children}: {children: React.ReactNode}) => children}));
vi.mock("../wallet/useWalletSession", () => ({WalletSessionProvider: ({children}: {children: React.ReactNode}) => children}));
vi.mock("../screens/P2PLoansScreen/P2PLoansScreen", () => ({P2PLoansScreen: () => <><BorrowPageHeader active="p2p" /><p>Token loan content</p></>}));
vi.mock("../nft/NFTLoansScreen", () => ({NFTLoansScreen: () => <><BorrowPageHeader active="nfts" /><p>NFT loan content</p></>}));
vi.mock("./PoolLoanDirectory", () => ({PoolLoanDirectory: () => <><BorrowPageHeader active="pools" /><p>Pool loan content</p></>}));

beforeEach(() => window.history.replaceState({}, "", "/borrow/p2p"));
afterEach(cleanup);

it("switches all loan sections and URLs without replacing the hero or duplicating headers", async () => {
  render(<BorrowExperience />);
  await screen.findByText("Token loan content");
  const canvas = screen.getByTestId("hero");
  for (const [name, path, content, theme] of [
    ["P2P NFTs", "/borrow/nfts", "NFT loan content", "nfts"],
    ["Pool loans", "/borrow/pools", "Pool loan content", "pools"],
    ["P2P stocks and memes", "/borrow/p2p", "Token loan content", "p2p"],
  ] as const) {
    fireEvent.click(screen.getByRole("link", {name}));
    await screen.findByText(content);
    expect(window.location.pathname).toBe(path);
    expect(screen.getByTestId("hero")).toBe(canvas);
    expect(canvas.getAttribute("data-theme")).toBe(theme);
    expect(screen.getAllByRole("navigation", {name:"Loan types"})).toHaveLength(1);
  }
});

it("restores the active content and hero theme with browser Back", async () => {
  render(<BorrowExperience />);
  await screen.findByText("Token loan content");
  const canvas = screen.getByTestId("hero");
  fireEvent.click(screen.getByRole("link", {name:"P2P NFTs"}));
  await screen.findByText("NFT loan content");
  window.history.back();
  await waitFor(() => expect(window.location.pathname).toBe("/borrow/p2p"));
  await screen.findByText("Token loan content");
  expect(screen.getByTestId("hero")).toBe(canvas);
  expect(canvas.getAttribute("data-theme")).toBe("p2p");
});

it("opens a direct NFT URL with the NFT scene selected", async () => {
  window.history.replaceState({}, "", "/borrow/nfts");
  render(<BorrowExperience initialTab="nfts" />);
  await screen.findByText("NFT loan content");
  expect(screen.getByTestId("hero").getAttribute("data-theme")).toBe("nfts");
});
