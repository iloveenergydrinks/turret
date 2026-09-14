import { parseAbi, keccak256 } from "viem";
import { alertsDeployment } from "./deployment.mjs";
import { positionHealth } from "../../../shared/position-health.mjs";
export const DEPLOYMENT = alertsDeployment();
export const VAULT = DEPLOYMENT.vault;
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const abi = parseAbi([
  "function collateralCount() view returns (uint256)",
  "function collateralAt(uint256) view returns (address)",
  "function positions(address,address) view returns (uint128,uint128)",
  "function price(address) view returns (uint256)",
  "function markets(address) view returns (address,address,uint128,uint16,uint16,uint16,uint16,uint8,uint8,bool)",
  "event Liquidated(address indexed collateral,address indexed borrower,address indexed liquidator,uint256 repaid,uint256 collateralSeized)",
]);

export class Monitor {
  constructor(engine, client, deployment = DEPLOYMENT) {
    this.engine = engine;
    this.client = client;
    this.healthyAt = 0;
    this.markets = [];
    this.deployment = deployment;
  }
  async scan() {
    const { engine: e, client: c } = this;
    const subscriptions = e.store.all("subscription");
    const wallets = [...new Set(subscriptions.map((s) => s.wallet))];
    try {
      if (await c.getChainId() !== 4663) throw new Error("Wrong chain");
      const block = await c.getBlock();
      if (Math.abs(e.now() - Number(block.timestamp) * 1000) > 60000) throw new Error("Stale chain head");
      const code = await c.getCode({ address: this.deployment.vault, blockNumber: block.number });
      if (!code || code === "0x") throw new Error("Missing vault");
      if (this.deployment.codeHash && keccak256(code).toLowerCase() !== this.deployment.codeHash.toLowerCase()) throw new Error("Vault bytecode mismatch");
      const read = (functionName, args = []) =>
        c.readContract({ address: this.deployment.vault, abi, functionName, args, blockNumber: block.number });
      const count = Number(await read("collateralCount"));
      if (count < 1 || count > 100) throw new Error("Invalid market count");
      this.markets = await Promise.all(Array.from({ length: count }, (_, i) => read("collateralAt", [BigInt(i)])));
      let complete = true;
      for (const market of this.markets) {
        let price = null, threshold = 0n;
        try {
          const config = await read("markets", [market]);
          threshold = BigInt(config[4]);
          price = await read("price", [market]);
        } catch {
          complete = false;
        }
        for (let offset = 0; offset < wallets.length; offset += 8) {
          await Promise.all(wallets.slice(offset, offset + 8).map(async wallet => {
            try {
              const [collateral, debt] = await read("positions", [market, wallet]);
              e.risk(wallet, market, positionHealth({ collateral, debt, price, liquidationLtvBps: threshold }));
            } catch {
              complete = false;
              e.risk(wallet, market, { status: "unknown" });
            }
          }));
        }
      }
      const confirmed = block.number > 12n ? block.number - 12n : 0n;
      const eventsCurrent = await this.events(confirmed, subscriptions);
      await this.transactions(confirmed);
      if (e.now() - Number(block.timestamp) * 1000 > 60000) throw new Error("Scan exceeded data freshness window");
      this.healthyAt = complete && eventsCurrent ? e.now() : 0;
      if (complete) {
        for (const wallet of wallets) {
          if (e.store.get("risk", `${wallet}:monitor`)) e.risk(wallet, "monitor", { status: "healthy" });
        }
      }
    } catch {
      this.healthyAt = 0;
      for (const wallet of wallets) {
        const existing = e.store.all("risk").filter((r) => r.wallet === wallet);
        for (const row of existing) e.risk(wallet, row.id.slice(wallet.length + 1), { status: "unknown" });
        if (!existing.length) e.risk(wallet, "monitor", { status: "unknown" });
      }
      throw new Error("Borrower monitor scan failed");
    }
  }
  async events(confirmed, subscriptions) {
    const { engine: e, client: c } = this;
    let cursor = e.store.get("cursor", "liquidations");
    if (!cursor || !subscriptions.length) {
      const block = await c.getBlock({ blockNumber: confirmed });
      e.store.put("cursor", "liquidations", { block: String(confirmed), hash: block.hash });
      return true;
    }
    const old = await c.getBlock({ blockNumber: BigInt(cursor.block) });
    if (old.hash !== cursor.hash) throw new Error("Confirmed event cursor reorg: operator review required");
    // Bounded catch-up. Never skip backlog after an outage.
    const fromBlock = BigInt(cursor.block) + 1n;
    if (fromBlock > confirmed) return true;
    const toBlock = fromBlock + 999n < confirmed ? fromBlock + 999n : confirmed;
    const logs = await c.getContractEvents({
      address: this.deployment.vault,
      abi,
      eventName: "Liquidated",
      fromBlock,
      toBlock,
      strict: true,
    });
    for (const log of logs) {
      const eventId = `${log.transactionHash}:${log.logIndex}`;
      if (e.store.get("event", eventId)) continue;
      const wallet = log.args.borrower.toLowerCase();
      const matching = subscriptions.filter((s) => s.wallet === wallet);
      if (matching.length) {
        const eventBlock = await c.getBlock({ blockNumber: log.blockNumber });
        if (matching.some((s) => s.created <= Number(eventBlock.timestamp) * 1000)) {
          e.notify(
            wallet,
            eventId,
            `Turret: liquidation confirmed.\nWallet: ${wallet}\nCollateral: ${log.args.collateral}\nUSDG debt repaid: ${
              Number(log.args.repaid) / 1e6
            }\nTransaction: ${log.transactionHash}\nReview your position: ${e.origin}/borrow`,
          );
        }
      }
      e.store.put("event", eventId, { until: e.now() + 7 * 86400000 });
    }
    const last = await c.getBlock({ blockNumber: toBlock });
    e.store.put("cursor", "liquidations", { block: String(toBlock), hash: last.hash });
    return toBlock === confirmed;
  }
  async watch(wallet, transactionHash) {
    if (!/^0x[0-9a-f]{64}$/i.test(transactionHash ?? "")) throw new Error("Invalid transaction");
    this.engine.rate(`transaction:${wallet}`, 30, 3600000);
    if (this.engine.store.get("event", `failed:${transactionHash}`)) return;
    // Never send user-supplied failure text. Verify sender and contract on-chain.
    const tx = await this.client.getTransaction({ hash: transactionHash });
    if (
      tx.from.toLowerCase() !== wallet
      || ![this.deployment.vault, USDG, ...this.markets].some((a) => a.toLowerCase() === tx.to?.toLowerCase())
    ) throw new Error("Transaction not from this wallet to Dockyard");
    this.engine.store.put("transaction", transactionHash, { wallet, until: this.engine.now() + 86400000 });
  }
  async transactions(confirmed) {
    for (const row of this.engine.store.all("transaction")) {
      let receipt;
      try {
        receipt = await this.client.getTransactionReceipt({ hash: row.id });
      } catch {
        continue;
      }
      if (receipt.blockNumber > confirmed) continue;
      if (receipt.status === "reverted" && !this.engine.store.get("event", `failed:${row.id}`)) {
        this.engine.notify(
          row.wallet,
          `failed:${row.id}`,
          `Turret: your submitted transaction failed on-chain.\n${row.id}\nYour intended action did not complete. Check your position: ${this.engine.origin}/borrow`,
        );
        this.engine.store.put("event", `failed:${row.id}`, { until: this.engine.now() + 7 * 86400000 });
      }
      this.engine.store.delete("transaction", row.id);
    }
  }
}
