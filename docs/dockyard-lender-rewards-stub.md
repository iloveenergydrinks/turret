# Lender rewards stub

The user reports that DOCK has launched and the 3% reserve is held. Its token address, network, actual inventory and treasury still need verification. The older purchase instructions are historical; this scaffold does not purchase or move tokens.

- `contracts/src/research/IDockyardLenderRewards.sol`: proposed per-pool share staking interface, with separate USDG and DOCK campaigns and claims.
- `contracts/src/research/DockyardLenderRewardsStub.sol`: deliberately abstract and non-deployable. All action placeholders revert. It holds no funds and implements no reward accounting.
- `frontend/app/src/lender-rewards.ts`: matching ABI, an empty campaign draft, disabled read state and a transaction-preparation function that always rejects. Amounts and rates are unavailable, not fabricated zero earnings.

The stub is not connected to public Earn or Portfolio pages. It adds no RPC polling, approvals, wallet requests, live reward display or deployment. Thirty days is a proposed duration; no tranche or start date is selected. The 3% field records the reported reserve, not a campaign emission budget.

To complete it: verify token/network and reserve; select eligible pools and exact USDG/DOCK budgets; implement funded reward accounting and independent claims; test share backing, solvency, rounding, failures and real pool withdrawals; then add reviewed staking/claim flows and campaign deployment/funding. Unstaking must return shares independently of claims, while withdrawing USDG continues through the pool's existing rules. The accounting and activation requirements remain in `dockyard-bootstrap-pilot.md` and `dockyard-dock-lender-rewards.md`.
