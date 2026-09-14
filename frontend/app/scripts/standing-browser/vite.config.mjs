import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const target = process.env.FACILITY_BROWSER_BACKEND, port = Number(process.env.FACILITY_BROWSER_PORT);
if (!target || new URL(target).hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1024) throw new Error("Start the dedicated local fixture first.");
export default defineConfig({ define: {'process.env.NEXT_PUBLIC_BLOG_URL': JSON.stringify('https://blog.turret.capital')}, resolve: {alias: {'@': fileURLToPath(new URL('../..',import.meta.url))}}, root: fileURLToPath(new URL(".", import.meta.url)), plugins: [{ name: 'local-test-wallet', enforce: 'pre', resolveId(source) { if(source.endsWith('/comps/AppLayout/AccountButton')) return fileURLToPath(new URL('test-account.tsx',import.meta.url)); if(source.endsWith('/wallet/useWalletSession')) return fileURLToPath(new URL('test-wallet.tsx',import.meta.url)); } }, react()], publicDir: fileURLToPath(new URL("../../public", import.meta.url)),
  server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [fileURLToPath(new URL("../../../..", import.meta.url))] },
    proxy: Object.fromEntries(["/api/", "/test-fixture", "/test-wallet-rpc", "/facility-markets.json", "/standing-offers.json", "/p2p-markets.json"].map(path => [path, { target, changeOrigin: false }])) } });
