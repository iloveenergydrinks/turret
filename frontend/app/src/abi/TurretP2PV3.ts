import { parseAbi } from "viem";

/** V3 additions. The shared offer/event ABI remains compatible with V1/V2. */
export const p2pV3Abi = parseAbi([
  "error InsufficientBacking()", "error InvalidCreditSources()", "error InvalidExtension()", "error StalePagination()",
  "function vaultImplementation() view returns (address)",
  "function vaults(uint256) view returns (address)",
  "function repaymentDeadline(uint256) view returns (uint256)",
  "function getActiveLoanIds(address,uint256,uint256,uint256) view returns (uint256[] ids,uint256 nextCursor,uint256 revision)",
  "function getIncomingOfferIds(address,uint256,uint256) view returns (uint256[] ids,uint256 nextCursor)",
  "function loanCredit(uint256,address) view returns (address beneficiary,uint256 nominal,uint256 available)",
  "function withdrawCredit(uint256,address,uint256,address)",
  "function withdrawAvailableCredit(uint256,address,uint256,address)",
  "function repayWithCredits(uint256,uint256[],uint256[],uint256)",
  "function extensionProposals(uint256) view returns (address proposer,uint256 nonce,uint256 oldDeadline,uint256 newDeadline,uint256 expiresAt)",
  "function proposeExtension(uint256,uint256,uint256)",
  "function acceptExtension(uint256,uint256,uint256,uint256,uint256)",
  "function cancelExtension(uint256,uint256)",
]);
