// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import registry from "../../public/p2p-markets.json";
import type { Deployment, Loan, OfferPage } from "../p2p/client";
vi.mock("./useMemecoinOffers",()=>({useMemecoinOffers:vi.fn()}));
import { MemecoinBorrowView } from "./MemecoinBorrow";
const market=registry.markets.find(m=>m.collateralSymbol==="CASHCAT"&&m.version===3) as Deployment;
const now=1_800_000_000_000;
const loan:Loan={id:7n,isPublic:true,status:"open",createdAt:now/1000-10,expiresAt:now/1000+300,dueAt:0,durationDays:7,
  principal:100_000000n,interest:5_000000n,collateral:1000n*10n**18n,fundingAvailable:100_000000n,
  lender:"0x1111111111111111111111111111111111111111",borrower:"0x0000000000000000000000000000000000000000"};
const page:OfferPage={offers:[loan],now:now/1000,blockNumber:100n,nextCursor:null,paused:false,
  health:{status:"ok",reasons:[],checkedAt:now,blockNumber:"100",blockHash:`0x${"a".repeat(64)}`}};
function data(p:Partial<OfferPage>={}) {return {reads:[{market,page:{...page,...p},checkedAt:now,error:false}],now,loading:false,error:false,address:undefined,wrongChain:false,balances:{},retry:vi.fn(),loadMore:vi.fn()};}
afterEach(cleanup);
test("switching memecoins resets term filters and uses the selected market for requests and lending",async()=>{
  const pons=registry.markets.find(m=>m.collateralSymbol==="PONS"&&m.version===3) as Deployment;
  const value=data();
  value.reads.push({market:pons,page:{...page,offers:[]},checkedAt:now,error:false});
  render(<MemecoinBorrowView data={value} />);
  await userEvent.selectOptions(screen.getByLabelText("You receive · USDG"),"100000000");
  await userEvent.selectOptions(screen.getByLabelText("Loan duration"),"7");
  await userEvent.selectOptions(screen.getByLabelText("Collateral"),pons.address);
  expect(screen.getByLabelText("You receive · USDG")).toHaveValue("");
  expect(screen.getByLabelText("Loan duration")).toHaveValue("");
  expect(screen.getByRole("link",{name:"Request a loan"})).toHaveAttribute("href",`/borrow/p2p?market=${pons.address}&intent=request`);
  expect(screen.getByRole("link",{name:"Create a lending offer"})).toHaveAttribute("href",`/borrow/p2p?market=${pons.address}&intent=lend`);
  expect(screen.queryByRole("link",{name:"Review loan"})).not.toBeInTheDocument();
});
test("owned memecoins appear first while an explicit selection stays selected",async()=>{
  const pons=registry.markets.find(m=>m.collateralSymbol==="PONS"&&m.version===3) as Deployment;
  const value={...data(),address:loan.lender,balances:{[pons.address]:1n}};
  value.reads.push({market:pons,page,checkedAt:now,error:false});
  const view=render(<MemecoinBorrowView data={value} />);
  expect(screen.getByLabelText("Collateral")).toHaveValue(pons.address);
  await userEvent.selectOptions(screen.getByLabelText("Collateral"),market.address);
  view.rerender(<MemecoinBorrowView data={{...value,balances:{[pons.address]:2n}}} />);
  expect(screen.getByLabelText("Collateral")).toHaveValue(market.address);
});
test("shows full repayment and links the exact reviewed contract and offer",()=>{
  render(<MemecoinBorrowView data={data()} />);
  expect(screen.getByText("105")).toBeVisible();
  expect(screen.getByRole("link",{name:"Review loan"})).toHaveAttribute("href",`/borrow/p2p?market=${market.address}&offer=7`);
  expect(screen.getByRole("link",{name:"Create a lending offer"})).toHaveAttribute("href",`/borrow/p2p?market=${market.address}&intent=lend`);
});
test("confirmed empty market requests terms without advertising available borrowing",()=>{
  render(<MemecoinBorrowView data={data({offers:[]})} />);
  expect(screen.getByRole("heading",{name:"No funded offers available"})).toBeVisible();
  expect(screen.getByRole("link",{name:"Request a loan"})).toHaveAttribute("href",`/borrow/p2p?market=${market.address}&intent=request`);
  expect(screen.queryByRole("link",{name:"Review loan"})).not.toBeInTheDocument();
});
test("failed observations do not pretend that the market is empty",()=>{
  const value=data();value.reads[0]!.error=true;
  render(<MemecoinBorrowView data={value} />);
  expect(screen.getByText("Unable to confirm funded availability")).toBeVisible();
  expect(screen.queryByText("No funded offers available")).not.toBeInTheDocument();
});
test("stale offers become unavailable without needing a user interaction",()=>{
  const value=data();const view=render(<MemecoinBorrowView data={value} />);
  view.rerender(<MemecoinBorrowView data={{...value,now:now+30_000}} />);
  expect(screen.queryByRole("link",{name:"Review loan"})).not.toBeInTheDocument();
});
test("filter combinations never resize an offer",async()=>{
  render(<MemecoinBorrowView data={data({offers:[loan,{...loan,id:8n,principal:200_000000n,fundingAvailable:200_000000n,durationDays:14}]})} />);
  await userEvent.selectOptions(screen.getByLabelText("You receive · USDG"),"100000000");
  await userEvent.selectOptions(screen.getByLabelText("Loan duration"),"14");
  expect(screen.getByText("No offers match these terms")).toBeVisible();
  expect(screen.queryByRole("link",{name:"Review loan"})).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button",{name:"Show all funded terms"}));
  expect(screen.getAllByRole("link",{name:"Review loan"})).toHaveLength(2);
});
test("paused market retains management and distinguishes the pause",()=>{
  render(<MemecoinBorrowView data={data({paused:true})} />);
  expect(screen.getByText("New loans are paused")).toBeVisible();
  expect(screen.queryByRole("link",{name:"Review loan"})).not.toBeInTheDocument();
  expect(screen.getByRole("link",{name:"Manage your existing loans"})).toHaveAttribute("href","/portfolio");
});
