import { readFile, open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, http } from "viem";
import { reconcileFacilityFees } from "../src/facilities/fee-reconciliation.mjs";

/** Read-only operator entry point. Produces unsigned calldata; never loads a signer or sends a transaction. */
export async function auditFeeJournal({ config, journal, client }) {
  if (!journal || journal.schemaVersion !== 1 || !journal.baseline || !Array.isArray(journal.collectionHashes) || !Array.isArray(journal.remittances)) throw new Error("Invalid fee journal.");
  const result = await reconcileFacilityFees({ client, config, baseline: journal.baseline, collectionHashes: journal.collectionHashes, remittances: journal.remittances });
  return { schemaVersion: 1, kind: "unsigned-facility-fee-remittance", ...result,
    sourceCollectionIds: result.unassigned.map(row => row.id),
    approval: result.gross > 0n && result.treasuryAllowance < result.maximumStakerShare ? {
      token: config.usdg, owner: config.treasury, spender: config.router, maximumAmount: result.maximumStakerShare,
      resetExistingAllowanceFirst: result.treasuryAllowance !== 0n,
    } : null,
    requirements: ["Only the configured treasury wallet may send the remittance.",
      "Re-audit after approval and immediately before signing; this report does not reserve fees or funds.",
      "After confirmation, record the remittance hash and these exact collection IDs in the same journal, then re-audit.",
      "If a submission times out, reconcile its transaction hash and wallet nonce before sending anything again.",
      "The router records this as treasury-reported fees. The journal supplies receipt attribution; the router does not enforce it on chain."],
  };
}
async function main() {
  const [configPath, journalPath, outputPath] = process.argv.slice(2);
  if (!configPath || !journalPath || !outputPath || process.argv.length !== 5) throw new Error("Usage: FACILITY_FEE_RPC_URL=... node scripts/facility-fee-audit.mjs config.json journal.json new-report.json");
  const rpc = new URL(process.env.FACILITY_FEE_RPC_URL ?? "");
  if (!["https:", "http:"].includes(rpc.protocol)) throw new Error("Use an HTTP RPC endpoint.");
  const [config, journal] = await Promise.all([configPath, journalPath].map(async path => JSON.parse(await readFile(resolve(path), "utf8"))));
  if (config.chainId !== 4663 && !(config.chainId === 31337 && ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname))) throw new Error("Unsupported fee audit chain.");
  const client = createPublicClient({ transport: http(rpc.href, { retryCount: 1, timeout: 10000 }) });
  const report = await auditFeeJournal({ config, journal, client });
  // Never overwrite the input journal or an earlier report. The journal is an operator-controlled allocation record.
  const file = await open(resolve(outputPath), "wx", 0o600);
  try { await file.writeFile(JSON.stringify(report, (_, value) => typeof value === "bigint" ? String(value) : value, 2) + "\n"); await file.sync(); } finally { await file.close(); }
  console.log(report.plan ? "Unsigned remittance report written. No transaction was signed or sent." : "Audit report written. No unassigned collected fees remain.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Fee audit failed. No transaction was signed or sent; verify the configuration, journal and RPC before retrying."); process.exitCode = 1; });
}
