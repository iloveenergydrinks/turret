import { INTEREST_DENOMINATOR as D, quoteCashback } from '../../../shared/borrower-cashback.mjs';

const min = (a, b) => a < b ? a : b;
const amount = value => {
  const n = BigInt(value);
  if (n < 0n || n >= 2n ** 256n) throw new Error('Invalid receipt amount');
  return n;
};
const key = (borrower, engine) => `${borrower.toLowerCase()}:${engine.toLowerCase()}`;

/** Replay complete, canonical engine history from deployment, in transaction/log order.
 * The ingestion boundary authenticates log addresses and supplies complete receipts.
 * Rational interest units preserve the engine's remainder between settlements.
 * Interest payments consume oldest accrual first; principal payments retire eligible draws first.
 */
export function accountReceipts(policy, receipts, asOf) {
  quoteCashback({ principal: 0n, aprBps: 0, now: policy.startsAt, days: 0, campaign: policy });
  const engines = Object.fromEntries(Object.entries(policy.engines).map(([address, info]) => {
    if (!Number.isSafeInteger(info.aprBps) || info.aprBps < 0 || info.aprBps > 10000)
      throw new Error('Invalid engine APR');
    return [address.toLowerCase(), info];
  }));
  const positions = new Map();
  const walletCap = policy.walletCap === undefined ? null : amount(policy.walletCap);
  if (walletCap !== null && walletCap !== 25_000000n) throw new Error("Invalid public wallet cap");
  const awarded = new Map();
  const seen = new Set();
  let lastTimestamp = 0;

  function accrue(p, timestamp) {
    if (timestamp < p.updatedAt) throw new Error('Receipt time moved backwards');
    // Separate pre-campaign, covered and post-campaign interest before oldest-first allocation.
    const boundaries = [p.updatedAt, policy.startsAt, policy.endsAt, timestamp]
      .filter(t => t >= p.updatedAt && t <= timestamp).sort((a, b) => a - b);
    for (let i = 1; i < boundaries.length; i++) {
      const from = boundaries[i - 1], to = boundaries[i];
      const factor = BigInt(to - from) * BigInt(engines[p.engine].aprBps);
      const total = p.principal * factor;
      const eligible = from >= policy.startsAt && to <= policy.endsAt ? p.eligiblePrincipal * factor : 0n;
      if (total > 0n) p.accrual.push({ total, eligible });
    }
    p.updatedAt = timestamp;
  }

  function consumeInterest(p, paid, earns) {
    let remaining = paid * D;
    const accrued = p.accrual.reduce((sum, chunk) => sum + chunk.total, 0n);
    if (remaining > accrued) throw new Error('Paid interest exceeds replayed accrual; incomplete history or wrong APR');
    while (remaining > 0n) {
      const chunk = p.accrual[0];
      const used = min(remaining, chunk.total);
      const eligible = chunk.eligible * used / chunk.total;
      if (earns) p.eligiblePaid += eligible;
      chunk.total -= used;
      chunk.eligible -= eligible;
      remaining -= used;
      if (chunk.total === 0n) p.accrual.shift();
    }
  }

  for (const receipt of receipts) {
    const { timestamp, transactionHash, events } = receipt;
    if (!Number.isSafeInteger(timestamp) || timestamp < lastTimestamp || !transactionHash || seen.has(transactionHash))
      throw new Error('Duplicate or unordered receipt');
    seen.add(transactionHash);
    lastTimestamp = timestamp;
    const liquidated = new Set(events.filter(e => e.event === 'Liquidated').map(e => key(e.borrower, e.engine)));
    for (const event of events) {
      if (!['Enrolled', 'Borrowed', 'Repaid', 'PositionLoss'].includes(event.event)) continue;
      const engine = event.engine.toLowerCase(), borrower = event.borrower.toLowerCase();
      if (!engines[engine]) throw new Error('Unapproved engine in receipt');
      const id = key(borrower, engine);
      let p = positions.get(id);
      if (!p) {
        p = { borrower, engine, principal: 0n, eligiblePrincipal: 0n, updatedAt: timestamp,
          accrual: [], eligiblePaid: 0n, confirmed: 0n, enrollment: null };
        positions.set(id, p);
      }
      accrue(p, timestamp);
      if (event.event === 'Enrolled') {
        const cap = amount(event.cap);
        if (p.enrollment || cap === 0n || event.startsAt !== Math.max(timestamp, policy.startsAt)
          || timestamp >= policy.endsAt) throw new Error('Invalid enrollment receipt');
        if (walletCap !== null && cap !== walletCap) throw new Error("Public enrollment cap mismatch");
        p.enrollment = { startsAt: event.startsAt, cap };
      } else if (event.event === 'Borrowed') {
        const drawn = amount(event.amount);
        p.principal += drawn;
        if (p.enrollment && timestamp >= p.enrollment.startsAt && timestamp < policy.endsAt)
          p.eligiblePrincipal += drawn;
      } else if (event.event === 'Repaid') {
        const principal = amount(event.principal), interest = amount(event.interest);
        consumeInterest(p, interest, !!p.enrollment && !liquidated.has(id) && timestamp <= policy.settlementDeadline);
        if (walletCap !== null && p.enrollment) {
          const earned = min(walletCap, p.eligiblePaid * 5000n / (D * 10000n));
          const used = awarded.get(borrower) ?? 0n;
          const delta = min(earned - p.confirmed, walletCap - used);
          p.confirmed += delta;
          awarded.set(borrower, used + delta);
        }
        if (principal > p.principal) throw new Error('Principal repayment exceeds replayed draws');
        p.principal -= principal;
        p.eligiblePrincipal -= min(principal, p.eligiblePrincipal);
        const unpaid = p.accrual.reduce((sum, chunk) => sum + chunk.total, 0n);
        if (principal > 0n && unpaid >= D) throw new Error('Principal paid before interest');
        if (p.principal === 0n && unpaid < D) p.accrual = []; // Engine _finish clears fractional dust.
      } else {
        const unpaid = p.accrual.reduce((sum, chunk) => sum + chunk.total, 0n) / D;
        if (amount(event.principal) !== p.principal || amount(event.interest) !== unpaid)
          throw new Error('Recognized loss does not match replayed debt');
        p.principal = 0n;
        p.eligiblePrincipal = 0n;
        p.accrual = [];
      }
    }
  }
  const timestamp = asOf ?? lastTimestamp;
  if (!Number.isSafeInteger(timestamp) || timestamp < lastTimestamp) throw new Error('Invalid accounting timestamp');
  const projectedByWallet = new Map(awarded);
  return [...positions.values()].filter(p => p.enrollment).sort((a,b) => key(a.borrower,a.engine).localeCompare(key(b.borrower,b.engine))).map(p => {
    accrue(p, timestamp);
    const unpaid = p.accrual.reduce((sum, chunk) => sum + chunk.total, 0n);
    const unpaidEligible = p.accrual.reduce((sum, chunk) => sum + chunk.eligible, 0n);
    const cap = p.enrollment.cap;
    const confirmedRebate = walletCap === null ? min(cap, p.eligiblePaid * 5000n / (D * 10000n)) : p.confirmed;
    let projected = timestamp > policy.settlementDeadline ? confirmedRebate
      : min(cap, (p.eligiblePaid + unpaidEligible) * 5000n / (D * 10000n));
    if (walletCap !== null) {
      const used = projectedByWallet.get(p.borrower) ?? 0n;
      const extra = min(projected - confirmedRebate, walletCap - used);
      projected = confirmedRebate + extra;
      projectedByWallet.set(p.borrower, used + extra);
    }
    return { borrower: p.borrower, engine: p.engine, ...p.enrollment, principal: p.principal,
      eligiblePrincipal: p.eligiblePrincipal, unpaidInterest: unpaid / D,
      estimatedRebate: projected - confirmedRebate, confirmedRebate,
      eligiblePaidInterest: p.eligiblePaid / D, committedRebate: projected };
  }).sort((a, b) => key(a.borrower, a.engine).localeCompare(key(b.borrower, b.engine)));
}
