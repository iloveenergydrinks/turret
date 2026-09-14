import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ProfileEngine } from './engine.mjs';
import { createProfileServer } from './http.mjs';
import { ProfileStore } from './store.mjs';
import { createOwnershipVerifier } from './verify.mjs';

const databasePath = process.env.PROFILE_DB_PATH ?? '/data/wallet-profiles.sqlite';
if (process.env.NODE_ENV === 'production' && (!resolve(databasePath).startsWith('/data/') || !existsSync('/data'))) {
  throw new Error('A persistent /data profile volume is required in production');
}
mkdirSync(dirname(resolve(databasePath)), { recursive: true });
const store = new ProfileStore(databasePath, {
  maxStoredImageBytes: Number(process.env.PROFILE_MAX_IMAGE_BYTES ?? 256 * 1024 * 1024),
  maxProfiles: Number(process.env.PROFILE_MAX_PROFILES ?? 100_000),
});
const engine = new ProfileEngine({
  store, origin: process.env.PROFILE_APP_ORIGIN ?? 'https://turret.capital',
  verify: createOwnershipVerifier({ rpcUrl: process.env.PROFILE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
    fallbackRpcUrls: (process.env.PROFILE_FALLBACK_RPC_URLS ?? '').split(',').map(value => value.trim()).filter(Boolean) }),
});
const server = createProfileServer({ engine, store, proxyToken: process.env.PROFILE_PROXY_TOKEN });
const port = Number(process.env.PORT ?? 3031);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid profile service port');
server.listen(port, '::', () => console.log('Turret wallet profile service ready'));
function shutdown() {
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
