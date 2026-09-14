import { createWalletClient, custom, keccak256, parseAbi, type Address, type Chain, type EIP1193Provider, type Hex } from "viem";
import { facilityAbi } from "../abi/TurretLenderFacility";
import type { TokenBaseline } from "../p2p/health-core.mjs";
import { readFacilityQuotes, validateFacilityEntry, type FacilityEntry } from "./reader.mjs";
import { assessQuote, drawAmounts, FRESH_MS, isAccount, parseSignedQuote, quoteDigest, quoteTypedData, quoteValues, same, type FacilityLimits, type Quote, type SignedQuote } from "./quotes.mjs";
import { FacilityTransactions, type FacilityProgress, type FacilityPublicClient } from "./wallet-transactions";

const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const vaultAbi = parseAbi(["function manager() view returns (address)", "function loanToken() view returns (address)", "function collateralToken() view returns (address)"]);
export type DrawReview = {
  account: Address; envelope: SignedQuote; digest: Hex; principal: bigint;
  collateral: bigint; interest: bigint; repayment: bigint; fee: bigint; lenderRepayment: bigint;
  maxDraw: bigint; minDraw: bigint; availableCapital: bigint; checkedAt: number; blockNumber: bigint; blockHash: Hex;
  feeBps: bigint; collateralBalance: bigint; allowance: bigint; nativeBalance: bigint;
};
export type QuoteReview = { account: Address; envelope: SignedQuote; digest: Hex; checkedAt: number; idleCash: bigint; feeBps: bigint; paused: boolean };
type Provider = EIP1193Provider;
export type FacilityLoanPage = {
  rows: { id: bigint; borrower: Address; principal: bigint; interest: bigint; dueAt: bigint; status: number }[];
  checked: number; nextCursor: bigint | null; indexComplete?: boolean; historyEpoch?: number;
};

/** Uses reviewed deployment configuration, never an address supplied by a quote URL. */
export class FacilityClient {
  readonly entry: FacilityEntry;
  private readonly baseline: TokenBaseline;
  readonly transactions: FacilityTransactions;
  private readonly reviews = new WeakMap<DrawReview, DrawReview>();
  private readonly quoteReviews = new WeakMap<QuoteReview, QuoteReview>();
  private signing = false;
  constructor(readonly options: { entry: FacilityEntry; baseline: TokenBaseline; chain: Chain; client: FacilityPublicClient; getAccount: () => Address | null; loanHistory?: (account: Address, cursor?: bigint) => Promise<FacilityLoanPage> }) {
    validateFacilityEntry(options.entry, options.baseline);
    if (options.chain.id !== options.entry.chainId) throw new Error("Facility chain configuration differs.");
    this.entry = Object.freeze(structuredClone(options.entry)); this.baseline = structuredClone(options.baseline);
    this.transactions = new FacilityTransactions({ address: this.entry.address, chain: options.chain, client: options.client, getAccount: options.getAccount, verify: async () => { await this.verifyIdentity(); } });
  }
  private account() { const account = this.options.getAccount(); if (!isAccount(account)) throw new Error("Connect your wallet first."); return account; }
  /** Recovery uses immutable identities, independent of mutable token qualification and lending pauses. */
  async verifyIdentity() {
    const { client } = this.options, e = this.entry;
    if (await client.getChainId() !== e.chainId) throw new Error("The read provider is on the wrong chain.");
    const block = await client.getBlock();
    if (block.number === null || !block.hash || Math.abs(Date.now() - Number(block.timestamp) * 1000) >= FRESH_MS) throw new Error("Current contract state is unavailable.");
    const read = (functionName: "lender" | "loanToken" | "collateralToken" | "feeRecipient" | "feeBps" | "vaultImplementation") => client.readContract({ address: e.address, abi: facilityAbi, functionName, blockNumber: block.number! });
    const [runtime, vaultRuntime, owner, cash, collateral, recipient, fee, vault, manager, vaultCash, vaultCollateral] = await Promise.all([
      client.getCode({ address: e.address, blockNumber: block.number }), client.getCode({ address: e.vaultImplementation, blockNumber: block.number }),
      read("lender"), read("loanToken"), read("collateralToken"), read("feeRecipient"), read("feeBps"), read("vaultImplementation"),
      ...(["manager", "loanToken", "collateralToken"] as const).map(functionName => client.readContract({ address: e.vaultImplementation, abi: vaultAbi, functionName, blockNumber: block.number! })),
    ]);
    if (!runtime || !vaultRuntime || !same(keccak256(runtime), e.runtimeHash) || !same(keccak256(vaultRuntime), e.vaultImplementationHash)
      || !same(owner, e.lender) || !same(cash, e.loanToken) || !same(collateral, e.collateralToken) || !same(recipient, e.feeRecipient)
      || fee !== BigInt(e.feeBps) || !same(vault, e.vaultImplementation) || !same(manager, e.address) || !same(vaultCash, e.loanToken) || !same(vaultCollateral, e.collateralToken)) throw new Error("Facility or vault identity could not be verified.");
    if (!same((await client.getBlock({ blockNumber: block.number })).hash, block.hash)) throw new Error("The chain changed during contract verification.");
    return { ...block, number: block.number, hash: block.hash };
  }
  async reviewDraw(value: unknown, principal: bigint): Promise<DrawReview> {
    const account = this.account(), envelope = parseSignedQuote(value);
    const snapshot = await readFacilityQuotes(this.options.client, this.entry, this.baseline, [envelope]);
    const observed = snapshot.rows[0]; if (!observed) throw new Error("The quote could not be verified.");
    const state = observed.observation, availability = assessQuote(envelope, state, { account });
    if (availability.status !== "available" || !availability.borrowerEligible) throw new Error(availability.reason ?? "This quote is not available to your wallet.");
    if (principal < availability.minDraw || principal > availability.maxDraw) throw new Error("Choose an amount inside the current minimum and maximum loan.");
    const amounts = drawAmounts(envelope, principal, state.feeBps), { client } = this.options;
    const [collateralBalance, allowance, nativeBalance] = await Promise.all([
      client.readContract({ address: this.entry.collateralToken, abi: tokenAbi, functionName: "balanceOf", args: [account], blockNumber: state.block.number }),
      client.readContract({ address: this.entry.collateralToken, abi: tokenAbi, functionName: "allowance", args: [account, this.entry.address], blockNumber: state.block.number }),
      client.getBalance({ address: account, blockNumber: state.block.number }),
    ]);
    if (!same(this.options.getAccount(), account)) throw new Error("Your wallet changed. Review the loan again.");
    if (collateralBalance < amounts.collateral) throw new Error("Your wallet does not hold enough collateral for this loan.");
    if (!same((await client.getBlock({ blockNumber: state.block.number })).hash, state.block.hash)
      || Date.now() - snapshot.checkedAt >= FRESH_MS || Math.abs(Date.now() - Number(state.block.timestamp) * 1000) >= FRESH_MS) throw new Error("The loan review became stale. Refresh it.");
    const review: DrawReview = { account, envelope, digest: quoteDigest(envelope), ...amounts, maxDraw: availability.maxDraw, minDraw: availability.minDraw,
      availableCapital: availability.capacity, checkedAt: snapshot.checkedAt, blockNumber: state.block.number, blockHash: state.block.hash, feeBps: state.feeBps,
      collateralBalance, allowance, nativeBalance };
    // Keep independent consent values even if a caller accidentally mutates the displayed object.
    this.reviews.set(review, structuredClone(review));
    return review;
  }
  async draw(provider: Provider, review: DrawReview, progress: FacilityProgress) {
    const consent = this.reviews.get(review);
    if (!consent || !same(consent.account, this.account())) throw new Error("Review this loan with your current wallet before signing.");
    if (!same(review.account, consent.account) || review.principal !== consent.principal || review.collateral !== consent.collateral || review.interest !== consent.interest
      || review.repayment !== consent.repayment || review.fee !== consent.fee || review.feeBps !== consent.feeBps || review.lenderRepayment !== consent.lenderRepayment
      || quoteDigest(review.envelope) !== consent.digest || review.envelope.signature !== consent.envelope.signature) throw new Error("The reviewed loan terms changed. Review them again.");
    // A quote is reusable but a borrower's consent is not. In particular, a timeout after a
    // successful draw must never turn a retry of this same review into a second loan.
    this.reviews.delete(review);
    const check = async () => {
      const fresh = await this.reviewDraw(consent.envelope, consent.principal);
      if (fresh.collateral !== consent.collateral || fresh.interest !== consent.interest || fresh.feeBps !== consent.feeBps) throw new Error("Loan costs changed. Review them again.");
    };
    return this.transactions.execute(provider, consent.account, { address: this.entry.address, abi: facilityAbi, functionName: "draw",
      args: [quoteValues(consent.envelope.quote), consent.envelope.signature, consent.principal, consent.collateral, consent.interest, consent.principal], label: "Borrow USDG" }, progress,
    { check, approval: { token: this.entry.collateralToken, amount: consent.collateral } });
  }
  async reviewQuote(terms: Quote): Promise<QuoteReview> {
    const account = this.account();
    const envelope = parseSignedQuote({ schemaVersion: 1, chainId: this.entry.chainId, facility: this.entry.address, quote: terms, signature: "0x" });
    if (BigInt(envelope.quote.expiresAt) > BigInt(Math.floor(Date.now() / 1000) + 86400)) throw new Error("Public quotes must expire within 24 hours.");
    const snapshot = await readFacilityQuotes(this.options.client, this.entry, this.baseline, [envelope]);
    const observation = snapshot.rows[0]?.observation; if (!observation) throw new Error("Current quote policy is unavailable.");
    const signer = await this.options.client.readContract({ address: this.entry.address, abi: facilityAbi, functionName: "quoteSigner", blockNumber: snapshot.block.number });
    if (!same(account, this.entry.lender) && !same(account, signer)) throw new Error("Only the lender or its appointed quote signer may authorize loans.");
    // Validate unsigned terms only. This does not assert signature validity or publish an offer.
    const termsCheck = assessQuote(envelope, { ...observation, signatureValid: true });
    if (!["available", "paused", "scheduled", "unfunded"].includes(termsCheck.status)) throw new Error(termsCheck.reason ?? "These quote terms cannot be published.");
    if (!same(this.options.getAccount(), account)) throw new Error("Your wallet changed. Review the quote again.");
    const review = { account, envelope, digest: quoteDigest(envelope), checkedAt: snapshot.checkedAt, idleCash: observation.idleCash, feeBps: observation.feeBps, paused: observation.paused };
    this.quoteReviews.set(review, structuredClone(review)); return review;
  }
  async signQuote(provider: Provider, review: QuoteReview, progress: FacilityProgress): Promise<SignedQuote> {
    if (this.signing) throw new Error("A quote signature is already being requested.");
    const consent = this.quoteReviews.get(review);
    if (!consent || !same(this.account(), consent.account) || quoteDigest(review.envelope) !== consent.digest) throw new Error("Review these quote terms with the signing wallet first.");
    this.signing = true;
    try {
      await this.transactions.assertWallet(provider, consent.account);
      await this.reviewQuote(consent.envelope.quote);
      await this.transactions.assertWallet(provider, consent.account);
      progress({ status: "signature", message: "Sign this quote to authorize loans from your deposited USDG on these terms." });
      const wallet = createWalletClient({ account: consent.account, chain: this.options.chain, transport: custom(provider, { retryCount: 0 }) });
      const signature = await wallet.signTypedData(quoteTypedData(consent.envelope));
      const signed = { ...consent.envelope, signature };
      await this.transactions.assertWallet(provider, consent.account);
      const verified = await readFacilityQuotes(this.options.client, this.entry, this.baseline, [signed]);
      const availability = assessQuote(signed, verified.rows[0]?.observation);
      if (!["available", "paused", "scheduled", "unfunded"].includes(availability.status)) throw new Error(availability.reason ?? "The signed quote is no longer authorized by the facility.");
      this.quoteReviews.delete(review); return signed;
    } finally { this.signing = false; }
  }
  async loan(id: bigint) {
    if (id <= 0n) throw new Error("Invalid loan number.");
    const block = await this.verifyIdentity();
    const raw = await this.options.client.readContract({ address: this.entry.address, abi: facilityAbi, functionName: "loans", args: [id], blockNumber: block.number });
    const [borrower, vault, principal, collateralAmount, interest, dueAt, lenderCredit, feeCredit, collateralCredit, status, defaultAcknowledged] = raw;
    if (status === 0) throw new Error("This loan does not exist.");
    if (!same((await this.options.client.getBlock({ blockNumber: block.number })).hash, block.hash)) throw new Error("The chain changed while reading the loan.");
    return { id, borrower, vault, principal, collateralAmount, interest, dueAt, lenderCredit, feeCredit, collateralCredit, status, defaultAcknowledged };
  }
  async loanCredits(id: bigint) {
    if (id <= 0n) throw new Error("Invalid loan number.");
    const block = await this.verifyIdentity();
    // Keep this separate from loan terms: a failing collateral balance getter must not hide repayment terms.
    const available = await Promise.allSettled((["availableRepayment", "availableFee", "availableCollateral"] as const).map(functionName =>
      this.options.client.readContract({ address: this.entry.address, abi: facilityAbi, functionName, args: [id], blockNumber: block.number })));
    if (!same((await this.options.client.getBlock({ blockNumber: block.number })).hash, block.hash)) throw new Error("The chain changed while checking credits.");
    const amount = (index: number) => { const result = available[index]; return result?.status === "fulfilled" ? result.value : null; };
    return { repayment: amount(0), fee: amount(1), collateral: amount(2), blockNumber: block.number, blockHash: block.hash };
  }
  async fundingState() {
    const block = await this.verifyIdentity(), { client } = this.options;
    const read = <N extends "idleCash" | "activePrincipal" | "unresolvedDefaultPrincipal" | "epoch" | "quoteSigner" | "limits" | "newLoansPaused">(functionName: N) => client.readContract({ address: this.entry.address, abi: facilityAbi, functionName, blockNumber: block.number });
    const [idleCash, activePrincipal, unresolvedDefaultPrincipal, epoch, quoteSigner, limits, paused] = await Promise.all([
      read("idleCash"), read("activePrincipal"), read("unresolvedDefaultPrincipal"), read("epoch"), read("quoteSigner"), read("limits"), read("newLoansPaused"),
    ]);
    const cash = await client.readContract({ address: this.entry.loanToken, abi: tokenAbi, functionName: "balanceOf", args: [this.entry.address], blockNumber: block.number }).catch(() => null);
    if (!same((await client.getBlock({ blockNumber: block.number })).hash, block.hash)) throw new Error("The chain changed while reading funding.");
    const [maxExposure, minDraw, maxDraw, minDuration, maxDuration, maxQuoteLifetime, minCollateralPerPrincipalWad, minInterestBps] = limits;
    return { idleCash, cash, activePrincipal, unresolvedDefaultPrincipal, epoch, quoteSigner, paused, timestamp: block.timestamp,
      limits: { maxExposure, minDraw, maxDraw, minDuration, maxDuration, maxQuoteLifetime, minCollateralPerPrincipalWad, minInterestBps } };
  }
  async extension(id: bigint) {
    if (id <= 0n) throw new Error("Invalid loan number.");
    const block = await this.verifyIdentity();
    const value = await this.options.client.readContract({ address: this.entry.address, abi: facilityAbi, functionName: "extensions", args: [id], blockNumber: block.number });
    if (!same((await this.options.client.getBlock({ blockNumber: block.number })).hash, block.hash)) throw new Error("The chain changed while checking the extension.");
    return value;
  }
  /** Browser clients use the durable index; isolated clients retain a bounded contract fallback. */
  async loanPage(account: Address, cursor?: bigint): Promise<FacilityLoanPage> {
    if (this.options.loanHistory) return this.options.loanHistory(account, cursor);
    const block = await this.verifyIdentity();
    const next = await this.options.client.readContract({ address: this.entry.address, abi: facilityAbi, functionName: "nextLoanId", blockNumber: block.number });
    const before = cursor === undefined ? next : cursor < next ? cursor : next;
    if (before < 1n) throw new Error("Invalid loan page.");
    const floor = before > 10n ? before - 10n : 1n;
    const ids: bigint[] = []; for (let id = before - 1n; id >= floor; id--) ids.push(id);
    const rows = await Promise.all(ids.map(async id => {
      const raw = await this.options.client.readContract({ address: this.entry.address, abi: facilityAbi, functionName: "loans", args: [id], blockNumber: block.number });
      return { id, borrower: raw[0], principal: raw[2], interest: raw[4], dueAt: raw[5], status: raw[9] };
    }));
    if (!same((await this.options.client.getBlock({ blockNumber: block.number })).hash, block.hash)) throw new Error("The chain changed while reading loans.");
    return { rows: rows.filter(loan => same(account, this.entry.lender) || same(account, loan.borrower)), checked: ids.length, nextCursor: floor > 1n ? floor : null };
  }
  async repay(provider: Provider, id: bigint, progress: FacilityProgress) {
    const loan = await this.loan(id);
    if (loan.status !== 1) throw new Error("This loan is no longer awaiting repayment.");
    return this.action(provider, "repay", [id], "Repay loan", progress, { token: this.entry.loanToken, amount: loan.principal + loan.interest });
  }
  private action(provider: Provider, functionName: string, args: readonly unknown[], label: string, progress: FacilityProgress, approval?: { token: Address; amount: bigint }, check?: () => Promise<void>) {
    return this.transactions.execute(provider, this.account(), { address: this.entry.address, abi: facilityAbi, functionName, args, label }, progress, { approval, check });
  }
  private owner() { if (!same(this.account(), this.entry.lender)) throw new Error("Only this facility's lender can perform this action."); }
  async deposit(provider: Provider, amount: bigint, progress: FacilityProgress) {
    this.owner(); if (amount <= 0n) throw new Error("Enter a positive deposit.");
    return this.action(provider, "deposit", [amount], "Deposit lending USDG", progress, { token: this.entry.loanToken, amount }, async () => { await readFacilityQuotes(this.options.client, this.entry, this.baseline, []); });
  }
  withdrawIdle(provider: Provider, amount: bigint, recipient: Address, progress: FacilityProgress) { this.owner(); return this.action(provider, "withdrawIdle", [amount, recipient], "Withdraw idle USDG", progress); }
  withdrawRepayment(provider: Provider, id: bigint, amount: bigint, recipient: Address, progress: FacilityProgress) { this.owner(); return this.action(provider, "withdrawRepayment", [id, amount, recipient], "Withdraw loan repayment", progress); }
  withdrawCollateral(provider: Provider, id: bigint, amount: bigint, recipient: Address, progress: FacilityProgress) { return this.action(provider, "withdrawCollateral", [id, amount, recipient], "Withdraw collateral", progress); }
  recycleRepayment(provider: Provider, id: bigint, progress: FacilityProgress) { return this.action(provider, "recycleRepayment", [id], "Return repayment to lending balance", progress); }
  collectFee(provider: Provider, id: bigint, progress: FacilityProgress) { return this.action(provider, "collectFee", [id], "Collect protocol fee", progress); }
  claimDefault(provider: Provider, id: bigint, progress: FacilityProgress) { return this.action(provider, "claimDefault", [id], "Settle overdue loan", progress); }
  acknowledgeDefault(provider: Provider, id: bigint, progress: FacilityProgress) { this.owner(); return this.action(provider, "acknowledgeDefault", [id], "Acknowledge default principal loss", progress); }
  acknowledgeIdleLoss(provider: Provider, progress: FacilityProgress) { this.owner(); return this.action(provider, "acknowledgeIdleLoss", [], "Acknowledge missing idle USDG", progress); }
  cancelQuote(provider: Provider, nonce: bigint, progress: FacilityProgress) { this.owner(); return this.action(provider, "cancelQuote", [nonce], "Cancel quote", progress); }
  pause(provider: Provider, paused: boolean, progress: FacilityProgress) { this.owner(); return this.action(provider, "setNewLoansPaused", [paused], paused ? "Pause new loans" : "Resume new loans", progress); }
  setPolicy(provider: Provider, limits: FacilityLimits, signer: Address, progress: FacilityProgress) { this.owner(); return this.action(provider, "setPolicy", [limits, signer], "Update limits and revoke previous quotes", progress); }
  withdrawSurplus(provider: Provider, amount: bigint, recipient: Address, progress: FacilityProgress) { this.owner(); return this.action(provider, "withdrawSurplus", [amount, recipient], "Withdraw surplus USDG", progress); }
  writeOffRepayment(provider: Provider, id: bigint, progress: FacilityProgress) { this.owner(); return this.action(provider, "writeOffRepayment", [id], "Acknowledge missing repayment", progress); }
  writeOffCollateral(provider: Provider, id: bigint, progress: FacilityProgress) { return this.action(provider, "writeOffCollateral", [id], "Acknowledge missing collateral", progress); }
  proposeExtension(provider: Provider, id: bigint, newDeadline: bigint, expiresAt: bigint, progress: FacilityProgress) { return this.action(provider, "proposeExtension", [id, newDeadline, expiresAt], "Propose a later repayment deadline", progress); }
  cancelExtension(provider: Provider, id: bigint, progress: FacilityProgress) { return this.action(provider, "cancelExtension", [id], "Cancel deadline proposal", progress); }
  acceptExtension(provider: Provider, id: bigint, nonce: bigint, oldDeadline: bigint, newDeadline: bigint, expiresAt: bigint, progress: FacilityProgress) { return this.action(provider, "acceptExtension", [id, nonce, oldDeadline, newDeadline, expiresAt], "Accept the reviewed repayment deadline", progress); }
}
