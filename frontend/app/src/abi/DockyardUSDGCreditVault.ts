import { parseAbi } from "viem";

export const dockyardVaultAbi = parseAbi([
  "function availableLiquidity() view returns (uint256)",
  "function originationFeeBps() view returns (uint16)",
  "function paused() view returns (bool)",
  "function positions(address collateral, address borrower) view returns (uint128 collateralAmount, uint128 debt)",
  "function price(address collateral) view returns (uint256)",
  "function borrowerAllowed(address borrower) view returns (bool)",
  "function globalDebtCeiling() view returns (uint256)",
  "function totalDebt() view returns (uint256)",
  "function marketDebt(address collateral) view returns (uint256)",
  "function markets(address) view returns (address primaryOracle, address secondaryOracle, uint128 debtCeiling, uint16 maxLtvBps, uint16 liquidationLtvBps, uint16 liquidationBonusBps, uint16 maxOracleDeviationBps, uint8 primaryOracleDecimals, uint8 secondaryOracleDecimals, bool enabled)",
  "function depositCollateral(address collateral, uint256 amount)",
  "function repay(address collateral, address borrower, uint256 amount) returns (uint256 repaid)",
  "function depositAndBorrow(address collateral, uint256 collateralAmount, uint256 borrowAmount)",
  "function depositAndBorrowChecked(address collateral, uint256 collateralAmount, uint256 borrowAmount, bytes proof)",
  "function repayAllAndWithdrawCollateral(address collateral, address recipient) returns (uint256 repaid, uint256 withdrawn)",
]);

export const dockyardErc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);
