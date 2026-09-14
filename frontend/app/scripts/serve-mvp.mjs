import {createCollateralSwapAPI} from './collateral-swap-api.mjs';
import { createReadStream, statSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBlogRequest } from "./blog-routing.mjs";
import { parseByteRange } from "./byte-range.mjs";
import { createRpcProxy } from "./rpc-proxy.mjs";
import { createP2PRequests, createP2PRequestsHandler, createFileRequestPersistence } from "./p2p-requests.mjs";
import { createP2PAlertsProxy } from "./p2p-alerts-proxy.mjs";
import { createMarketPrices, createMarketPricesHandler } from "./p2p-market-prices.mjs";
import { createProfileProxy } from "./profile-proxy.mjs";
import { createBorrowerCashbackProxy } from "./borrower-cashback-proxy.mjs";
import { createSiteAccess } from "./site-access.mjs";
import { createPublicClient, custom } from "viem";
import { createReadRpcFallback } from "../../../shared/rpc-fallback.mjs";
import { createP2PLoanIndex, createP2PActiveLoansHandler, createFileLoanIndexPersistence } from "./p2p-loan-index.mjs";
import { createP2PNegotiations, createNegotiationsHandler } from "./p2p-negotiations.mjs";
import { createNFTPlatform } from "./nft-platform.mjs";
import { createFacilityPlatform } from "./facility-platform.mjs";
import { serveStandingConfig } from "./standing-config-response.mjs";
import { createStandingAccountIndex } from "./standing-account-index.mjs";
import { createStandingDirectory } from "./standing-facilities.mjs";
import { withConsent } from "./consent-html.mjs";
import { withFooter } from "./footer-html.mjs";
import { withEarnKnight } from "./earn-knight-html.mjs";

const outputDirectory = resolve(fileURLToPath(new URL("../out/", import.meta.url)));
const port = Number.parseInt(process.env.PORT || "3000", 10);
const proxyRpc = createRpcProxy();
const profileProxy = createProfileProxy();
const borrowerCashbackProxy = createBorrowerCashbackProxy();
const siteAccess = createSiteAccess();
const collateralSwapHandler = createCollateralSwapAPI();
// Registry is release-owned. Requests cannot choose upstreams, deployment blocks or custody addresses.
const p2pRegistry = JSON.parse(readFileSync(new URL("../public/p2p-markets.json", import.meta.url), "utf8"));
const p2pRpc = createReadRpcFallback({ urls: [process.env.DOCKYARD_RPC_URL
  || process.env.NEXT_PUBLIC_CHAIN_RPC_URL || "https://rpc.mainnet.chain.robinhood.com/",
  ...(process.env.DOCKYARD_RPC_FALLBACK_URLS || "").split(",").filter(Boolean)], timeoutMs: 10000 });
const p2pReadClient = createPublicClient({ transport: custom({ request: p2pRpc.request }, { retryCount: 0 }) });
const facilityRegistryPath = new URL("../public/facility-markets.json", import.meta.url);
const standingConfigPath = new URL("../public/standing-offers.json", import.meta.url);
const standingConfig = statSync(standingConfigPath, { throwIfNoEntry: false })?.isFile() ? JSON.parse(readFileSync(standingConfigPath, "utf8")) : null;
const facilityOrigin = new URL(process.env.FACILITY_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || "https://turret.capital").origin;
const standingDirectory = standingConfig?.factory ? createStandingDirectory({ config: standingConfig, client: p2pReadClient, origin: facilityOrigin, databasePath: process.env.FACILITY_QUOTES_DATABASE }) : null;
const standingAccountIndex = standingDirectory ? createStandingAccountIndex({ config: standingConfig, client: p2pReadClient, directory: standingDirectory, databasePath: process.env.FACILITY_QUOTES_DATABASE }) : null;
const facilityHandler = createFacilityPlatform({
  config: statSync(facilityRegistryPath, { throwIfNoEntry: false })?.isFile()
    ? { ...JSON.parse(readFileSync(facilityRegistryPath, "utf8")), ...(standingDirectory ? { baseline: standingConfig.baseline } : {}) } : { schemaVersion: 1, entries: [], baseline: standingConfig?.baseline ?? null },
  client: p2pReadClient,
  origin: new URL(process.env.FACILITY_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || "https://turret.capital").origin,
  databasePath: process.env.FACILITY_QUOTES_DATABASE,
  resolveEntry: standingDirectory?.resolveEntry,
});
const marketPricesHandler = createMarketPricesHandler(createMarketPrices({ client: p2pReadClient, markets: p2pRegistry.markets }));
const p2pIndex = createP2PLoanIndex({ markets: p2pRegistry.markets, client: p2pReadClient, maxConcurrentSync: 12,
  persistence: createFileLoanIndexPersistence(process.env.P2P_INDEX_DIRECTORY || "/tmp/turret-p2p-active-loans") });
const activeLoanHandler = createP2PActiveLoansHandler(p2pIndex);
const p2pRequestsHandler = createP2PRequestsHandler(createP2PRequests({
  markets: p2pRegistry.markets, client: p2pReadClient,
  origin: new URL(process.env.P2P_REQUESTS_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || "https://turret.capital").origin,
  persistence: createFileRequestPersistence(process.env.P2P_REQUESTS_DIRECTORY || resolve(".data/p2p-requests")),
}));
const negotiationsHandler = createNegotiationsHandler(createP2PNegotiations({
  markets: p2pRegistry.markets, client: p2pReadClient,
  origin: new URL(process.env.P2P_REQUESTS_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || "https://turret.capital").origin,
  filename: resolve(process.env.P2P_REQUESTS_DIRECTORY || ".data/p2p-requests", "negotiations.sqlite"),
}));
const p2pAlertsProxy = createP2PAlertsProxy();
const nftAlertsProxy = createP2PAlertsProxy({ url: process.env.NFT_ALERTS_URL || '', mountPath: '/api/nft-alerts' });
const nftRegistryPath = new URL("../public/nft-market.json", import.meta.url);
const nftHandler = createNFTPlatform({
  config: statSync(nftRegistryPath, { throwIfNoEntry: false })?.isFile() ? JSON.parse(readFileSync(nftRegistryPath, "utf8")) : null,
  client: p2pReadClient,
  origin: new URL(process.env.P2P_REQUESTS_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || "https://turret.capital").origin,
  directory: process.env.NFT_REQUESTS_DIRECTORY || resolve(process.env.P2P_REQUESTS_DIRECTORY || ".data/p2p-requests", "nfts"),
  rpcUrls: [process.env.DOCKYARD_RPC_URL, process.env.NEXT_PUBLIC_CHAIN_RPC_URL, ...(process.env.DOCKYARD_RPC_FALLBACK_URLS || "").split(",")],
});
// Keep discovery warm independently of a borrower's history or browser session.
let warmMarket = 0;
async function warmActiveLoans() {
  try { if (p2pIndex.markets.length) await p2pIndex.syncMarket(p2pIndex.markets[warmMarket++ % p2pIndex.markets.length]); }
  catch { /* API reports incomplete/unavailable; never publish a false empty success. */ }
  setTimeout(warmActiveLoans, 1000).unref();
}
void warmActiveLoans();
const blogHostname = new URL(process.env.NEXT_PUBLIC_BLOG_URL || "https://blog.turret.capital").hostname;
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".vtt": "text/vtt; charset=utf-8",
};

function securityHeaders() {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "img-src 'self' data: https://turret.capital https://consent.cookiebot.com https://consentcdn.cookiebot.com",
      "style-src 'self' 'unsafe-inline' https://turret.capital",
      "script-src 'self' 'unsafe-inline' https://turret.capital https://consent.cookiebot.com https://consentcdn.cookiebot.com",
      "frame-src 'self' https://consentcdn.cookiebot.com",
      "font-src 'self' data:",
      // The verified deployment is a static app, but wallet, RPC, explorer,
      // and subgraph clients still need outbound HTTPS/WebSocket access.
      "connect-src 'self' https: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'none'",
    ].join("; "),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function sendFile(request, response, filePath, status = 200) {
  const stats = statSync(filePath, { throwIfNoEntry: false });
  if (!stats?.isFile()) return false;

  const extension = extname(filePath);
  const htmlBytes = extension === ".html" ? Buffer.from(withEarnKnight(withFooter(withConsent(readFileSync(filePath, "utf8"), (request.headers.host || "").split(":")[0].toLowerCase())))) : null;
  const isVersionedAsset = filePath.includes(`${sep}_next${sep}static${sep}`)
    || /\/(?:platform-assets|p2p-assets)\/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/.test(filePath);
  const isDocument = extension === ".html" || extension === ".txt" || extension === ".md";

  const range = request.method === "GET" && extension === ".mp4"
    ? parseByteRange(request.headers.range, stats.size)
    : null;
  if (range === false) {
    response.writeHead(416, {
      ...securityHeaders(),
      "Content-Range": `bytes */${stats.size}`,
      "Content-Length": 0,
    }).end();
    return true;
  }

  response.writeHead(range ? 206 : status, {
    ...securityHeaders(),
    "Cache-Control": isVersionedAsset
      ? "public, max-age=31536000, immutable"
      : isDocument || filePath.endsWith(`${sep}p2p-token-baseline.json`)
      ? "no-store"
      : "public, max-age=3600",
    "Content-Length": htmlBytes ? htmlBytes.length : range ? range.end - range.start + 1 : stats.size,
    ...(extension === ".mp4" ? { "Accept-Ranges": "bytes" } : {}),
    ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${stats.size}` } : {}),
    "Content-Type": filePath.endsWith(`${sep}feed.xml`)
      ? "application/rss+xml; charset=utf-8"
      : contentTypes[extension] || "application/octet-stream",
  });
  if (request.method === "HEAD") response.end();
  else if (htmlBytes) response.end(htmlBytes);
  else createReadStream(filePath, range || undefined).pipe(response);
  return true;
}

createServer((request, response) => {
  void handleRequest(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end("Unable to serve this request.");
  });
}).listen(port, "0.0.0.0", () => {
  console.log(`Turret frontend listening on port ${port}`);
});

async function handleRequest(request, response) {
  if (await siteAccess(request, response)) return;
  if (serveStandingConfig(request, response, standingConfig, securityHeaders())) return;
  if (standingAccountIndex && await standingAccountIndex.mount(request, response, securityHeaders())) return;
  if (standingDirectory && await standingDirectory.mount(request, response, securityHeaders())) return;
  if (await facilityHandler(request, response, securityHeaders())) return;
  if (await borrowerCashbackProxy(request, response)) return;
  if (await collateralSwapHandler(request, response, securityHeaders())) return;
  if (await marketPricesHandler(request, response, securityHeaders())) return;
  if (await activeLoanHandler(request, response, securityHeaders())) return;
  if (await p2pRequestsHandler(request, response, securityHeaders())) return;
  if (await negotiationsHandler(request, response, securityHeaders())) return;
  if (await nftHandler(request, response, securityHeaders())) return;
  if (await p2pAlertsProxy(request, response)) return;
  if (await nftAlertsProxy(request, response)) return;
  if (await profileProxy(request, response, securityHeaders())) return;
  if (new URL(request.url || "/", "http://localhost").pathname === "/api/rpc") {
    void proxyRpc(request, response, securityHeaders());
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, securityHeaders()).end();
    return;
  }

  const routed = resolveBlogRequest(
    new URL(request.url || "/", "http://localhost").pathname,
    request.headers.host,
    blogHostname,
  );
  if (routed.badRequest) {
    response.writeHead(400, securityHeaders()).end("Invalid request path");
    return;
  }
  if (routed.redirect) {
    response.writeHead(308, { ...securityHeaders(), Location: routed.redirect + new URL(request.url || "/", "http://localhost").search }).end();
    return;
  }
  const pathname = routed.pathname;
  const borrowURL = new URL(request.url || "/", "http://localhost");
  if (pathname === "/borrow" && !borrowURL.searchParams.has("engine") && !borrowURL.searchParams.has("market")) {
    response.writeHead(302, { ...securityHeaders(), "Cache-Control": "no-store", Location: "/borrow/p2p" + borrowURL.search }).end();
    return;
  }
  if (pathname === "/") {
    sendFile(request, response, resolve(outputDirectory, "index.html"));
    return;
  }

  const filePath = resolve(outputDirectory, `.${pathname}`);
  const isInsideOutput = filePath.startsWith(`${outputDirectory}${sep}`);
  const allowedFile = /\.(?:css|html|ico|js|json|png|jpg|webp|svg|txt|md|xml|woff2?|mp4|vtt)$/.test(filePath);
  if (isInsideOutput && allowedFile && sendFile(request, response, filePath)) return;

  // Next's static export writes application routes as `/route.html`.
  // Preserve clean URLs so links such as `/borrow/aapl` do not fall back to
  // the landing page.
  if (isInsideOutput && !extname(filePath) && sendFile(request, response, `${filePath}.html`)) return;
  if (isInsideOutput && !extname(filePath) && sendFile(request, response, resolve(filePath, "index.html"))) return;

  if (routed.isBlog) {
    if (!sendFile(request, response, resolve(outputDirectory, "404.html"), 404)) {
      response.writeHead(404, securityHeaders()).end("Page not found");
    }
    return;
  }

  response.writeHead(302, { ...securityHeaders(), Location: "/" }).end();
}
