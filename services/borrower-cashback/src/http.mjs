import { createServer } from 'node:http';
import { isAddress, keccak256, parseAbi } from 'viem';
import { verifyAllocationClaim } from './merkle.mjs';

const abi = parseAbi([
  'function rewardToken() view returns(address)', 'function startsAt() view returns(uint64)',
  'function endsAt() view returns(uint64)', 'function settlementDeadline() view returns(uint64)',
  'function claimDeadline() view returns(uint64)', 'function REBATE_BPS() view returns(uint256)',
  'function totalFunded() view returns(uint256)', 'function totalCommitted() view returns(uint256)',
  'function WALLET_CAP() view returns(uint256)', 'function BUDGET_CAP() view returns(uint256)',
  'function joined(address) view returns(bool)', 'function walletClaimed(address) view returns(uint256)',
  'function enrollmentPaused() view returns(bool)',
  'function enrollments(address,address) view returns(uint256 cap,uint64 startsAt)',
  'function claimed(address,address) view returns(uint256)', 'function publishedRoots(bytes32) view returns(bool)',
]);

async function verifiedCampaign(client, config) {
  if (await client.getChainId() !== config.chainId) throw new Error('Wrong rewards chain');
  const block = await client.getBlock();
  const code = await client.getCode({ address: config.distributor, blockNumber: block.number });
  if (!code || keccak256(code) !== config.runtimeHash) throw new Error('Wrong distributor runtime');
  const read = (functionName, args = []) => client.readContract({ address: config.distributor, abi,
    functionName, args, blockNumber: block.number });
  const [token, start, end, settlement, deadline, rate, funded, committed, paused] = await Promise.all([
    read('rewardToken'), read('startsAt'), read('endsAt'), read('settlementDeadline'), read('claimDeadline'),
    read('REBATE_BPS'), read('totalFunded'), read('totalCommitted'), read('enrollmentPaused'),
  ]);
  const { startsAt, endsAt, settlementDeadline, claimDeadline, rebateBps } = config.policy;
  if (token.toLowerCase() !== config.rewardToken.toLowerCase() || start !== BigInt(startsAt) || end !== BigInt(endsAt)
    || settlement !== BigInt(settlementDeadline) || deadline !== BigInt(claimDeadline) || rate !== BigInt(rebateBps)
    || committed > funded) throw new Error('Campaign configuration mismatch');
  let publicEnrollment = null;
  if (config.policy.walletCap !== undefined) {
    const [walletCap,budgetCap] = await Promise.all([read('WALLET_CAP'),read('BUDGET_CAP')]);
    if (walletCap !== 25_000000n || budgetCap !== 1000_000000n || config.policy.walletCap !== String(walletCap) || funded > budgetCap)
      throw new Error('Public enrollment limits mismatch');
    publicEnrollment = { walletCap, budgetCap };
  }
  return { read, block, public: { chainId: config.chainId, distributor: config.distributor, rewardToken: token,
    campaign: { startsAt, endsAt, settlementDeadline, claimDeadline, rebateBps }, totalFunded: funded,
    totalCommitted: committed, enrollmentPaused: paused, publicEnrollment } };
}

export function createRewardsServer({ config, client, ledger, allocations = [], health }) {
  return createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
    };
    if (request.method !== 'GET') return send(405, { error: 'Read-only rewards API' });
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/healthz') {
      const status = health?.() ?? { ready: !config };
      return send(status.ready ? 200 : 503, status);
    }
    if (path.startsWith('/v1/rewards/') && !isAddress(path.slice('/v1/rewards/'.length)))
      return send(400, { error: 'Invalid wallet address' });
    if (path !== '/v1/campaign' && !path.startsWith('/v1/rewards/')) return send(404, { error: 'Not found' });
    if (!config) return send(200, { status: 'inactive', campaign: null });
    if (health && !health().ready) return send(503, {status:'unavailable',error:'Campaign history is catching up'});
    try {
      const verified = await verifiedCampaign(client, config);
      const head = ledger.head();
      if (head && (BigInt(head.number) > verified.block.number
        || (await client.getBlock({ blockNumber: BigInt(head.number) })).hash !== head.hash))
        throw new Error('Ledger needs canonical-chain recovery');
      const fresh = !!head && Number(verified.block.timestamp) - head.timestamp <= 120
        && Number(verified.block.timestamp) >= head.timestamp;
      const body = { status: 'ready', ...verified.public, asOf: head, fresh };
      if (path === '/v1/campaign') return send(200, body);
      const borrower = path.slice('/v1/rewards/'.length).toLowerCase();
      const rows = ledger.account(borrower);
      const accounts = await Promise.all(rows.map(async (row) => {
        const [enrollment, claimed] = await Promise.all([
          verified.read('enrollments', [borrower, row.engine]), verified.read('claimed', [borrower, row.engine]),
        ]);
        if (enrollment[0] !== row.cap || Number(enrollment[1]) !== row.startsAt) throw new Error('Enrollment mismatch');
        let claim = null;
        for (const allocation of allocations) {
          if (allocation.chainId !== config.chainId || allocation.distributor.toLowerCase() !== config.distributor.toLowerCase())
            throw new Error('Allocation domain mismatch');
          for (const candidate of allocation.claims) {
            if (candidate.borrower.toLowerCase() !== borrower || candidate.engine.toLowerCase() !== row.engine) continue;
            const cumulative = BigInt(candidate.cumulative);
            if (cumulative > row.cap || !verifyAllocationClaim(allocation, candidate)) throw new Error('Invalid allocation');
            if (cumulative <= claimed || (claim && cumulative <= claim.cumulative)) continue;
            if (await verified.read('publishedRoots', [allocation.root]))
              claim = { root: allocation.root, borrower, engine: row.engine, cumulative, proof: candidate.proof };
          }
        }
        const claimable = claim && verified.block.timestamp <= BigInt(config.policy.claimDeadline)
          ? claim.cumulative - claimed : 0n;
        return { ...row, estimatedRebate: fresh ? row.estimatedRebate : null,
          committedRebate: fresh ? row.committedRebate : null, claimed, claimable,
          claim: claimable > 0n ? claim : null };
      }));
      const joined = verified.public.publicEnrollment ? await verified.read('joined',[borrower]) : null;
      if (verified.public.publicEnrollment) {
        const cap = verified.public.publicEnrollment.walletCap;
        for (const field of ['confirmedRebate','claimed','claimable'])
          if (accounts.reduce((sum,row)=>sum+row[field],0n)>cap) throw new Error('Wallet cashback exceeds public cap');
      }
      return send(200, { ...body, accounts, joined });
    } catch {
      return send(503, { status: 'unavailable', error: 'Campaign verification unavailable' });
    }
  });
}
