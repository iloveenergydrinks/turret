import { isAddress } from "viem";
import { createNFTAssets, createNFTAssetsHandler, alchemyNFTBase } from "./nft-assets.mjs";
import { createNFTRequests, createNFTRequestsHandler, createNFTRequestPersistence } from "./nft-requests.mjs";

/** Release-owned configuration. No request can select a chain, manager or NFT API key. */
export function createNFTPlatform({ config, client, origin, directory, rpcUrls }) {
  if (!config) return async () => false;
  const address = value => typeof value === "string" && isAddress(value, { strict: false }) && !/^0x0{40}$/i.test(value);
  if (config.version !== 1 || config.chainId !== 4663 || !address(config.address) || !address(config.loanToken)
    || config.loanDecimals !== 6 || !/^0x[0-9a-f]{64}$/i.test(config.runtimeHash)
    || !/^[1-9][0-9]*$/.test(config.startBlock) || config.rpcUrl !== "/api/rpc"
    || !Array.isArray(config.collections) || !config.collections.length
    || config.collections.some(c => !address(c.address) || typeof c.enabled !== "boolean" || typeof c.name !== "string" || !c.name)
    || new Set(config.collections.map(c => c.address.toLowerCase())).size !== config.collections.length
    || !directory || new URL(origin).origin !== origin) throw Error("Invalid NFT release configuration");
  const requests = createNFTRequestsHandler(createNFTRequests({ client, origin,
    markets: [{ ...config, collections: config.collections.filter(c => c.enabled).map(c => c.address) }],
    persistence: createNFTRequestPersistence(directory),
  }));
  const assets = createNFTAssetsHandler(createNFTAssets({ collections: config.collections, baseUrl: alchemyNFTBase(rpcUrls) }));
  return async (request, response, headers) => await requests(request, response, headers) || await assets(request, response, headers);
}
