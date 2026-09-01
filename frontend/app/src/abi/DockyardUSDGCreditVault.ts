import { parseAbi } from "viem";

export const dockyardVaultAbi = parseAbi([
  "function availableLiquidity() view returns (uint256)",
  "function originationFeeBps() view returns (uint16)",
  "function paused() view returns (bool)",
  "function positions(address collateral, address borrower) view returns (uint128 collateralAmount, uint128 debt)",
  "function price(address collateral) view returns (uint256)",
  "function depositAndBorrow(address collateral, uint256 collateralAmount, uint256 borrowAmount)",
  "function repayAllAndWithdrawCollateral(address collateral, address recipient) returns (uint256 repaid, uint256 withdrawn)",
]);

export const dockyardErc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);
