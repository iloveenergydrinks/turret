import type { Address } from "viem";
import { isAddress } from "viem";

export const DOCKYARD_USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

const configuredVault = process.env.NEXT_PUBLIC_DOCKYARD_VAULT_ADDRESS;

export const DOCKYARD_VAULT_ADDRESS: Address | null = configuredVault && isAddress(configuredVault)
  ? configuredVault
  : null;

export const DOCKYARD_STANDALONE_DEPLOYMENT = DOCKYARD_VAULT_ADDRESS !== null;

export const DOCKYARD_MARKETS = [
  {
    symbol: "AAPL",
    name: "Apple",
    address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
    maxLtvBps: 5_214,
    liquidationLtvBps: 5_714,
  },
  {
    symbol: "MSFT",
    name: "Microsoft",
    address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
    maxLtvBps: 5_214,
    liquidationLtvBps: 5_714,
  },
  {
    symbol: "GOOGL",
    name: "Alphabet",
    address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
    maxLtvBps: 5_055,
    liquidationLtvBps: 5_555,
  },
  {
    symbol: "AMZN",
    name: "Amazon",
    address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
    maxLtvBps: 4_905,
    liquidationLtvBps: 5_405,
  },
  {
    symbol: "META",
    name: "Meta Platforms",
    address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35",
    maxLtvBps: 4_763,
    liquidationLtvBps: 5_263,
  },
  {
    symbol: "NVDA",
    name: "Nvidia",
    address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    maxLtvBps: 4_500,
    liquidationLtvBps: 5_000,
  },
  {
    symbol: "AMD",
    name: "Advanced Micro Devices",
    address: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC",
    maxLtvBps: 4_500,
    liquidationLtvBps: 5_000,
  },
  {
    symbol: "ORCL",
    name: "Oracle",
    address: "0xb0992820E760d836549ba69BC7598b4af75dEE03",
    maxLtvBps: 4_500,
    liquidationLtvBps: 5_000,
  },
  {
    symbol: "MU",
    name: "Micron",
    address: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD",
    maxLtvBps: 3_944,
    liquidationLtvBps: 4_444,
  },
  {
    symbol: "TSLA",
    name: "Tesla",
    address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    maxLtvBps: 3_500,
    liquidationLtvBps: 4_000,
  },
] as const satisfies readonly {
  symbol: string;
  name: string;
  address: Address;
  maxLtvBps: number;
  liquidationLtvBps: number;
}[];

export type DockyardMarket = (typeof DOCKYARD_MARKETS)[number];

export function getDockyardMarket(symbol: string): DockyardMarket | null {
  return DOCKYARD_MARKETS.find((market) => market.symbol.toLowerCase() === symbol.toLowerCase()) ?? null;
}
