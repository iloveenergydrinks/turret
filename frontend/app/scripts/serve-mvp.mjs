import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const outputDirectory = resolve(fileURLToPath(new URL("../out/", import.meta.url)));
const port = Number.parseInt(process.env.PORT || "3000", 10);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function securityHeaders() {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
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

function sendFile(request, response, filePath) {
  const stats = statSync(filePath, { throwIfNoEntry: false });
  if (!stats?.isFile()) return false;

  const extension = extname(filePath);
  const isVersionedAsset = filePath.includes(`${sep}_next${sep}static${sep}`);
  const isDocument = extension === ".html" || extension === ".txt";

  response.writeHead(200, {
    ...securityHeaders(),
    "Cache-Control": isVersionedAsset
      ? "public, max-age=31536000, immutable"
      : isDocument
      ? "no-store"
      : "public, max-age=3600",
    "Content-Length": stats.size,
    "Content-Type": contentTypes[extension] || "application/octet-stream",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath).pipe(response);
  return true;
}

createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, securityHeaders()).end();
    return;
  }

  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  if (pathname === "/") {
    sendFile(request, response, resolve(outputDirectory, "index.html"));
    return;
  }

  const filePath = resolve(outputDirectory, `.${pathname}`);
  const isInsideOutput = filePath.startsWith(`${outputDirectory}${sep}`);
  const allowedFile = /\.(?:css|html|ico|js|json|png|svg|txt|woff2?)$/.test(filePath);
  if (isInsideOutput && allowedFile && sendFile(request, response, filePath)) return;

  // Next's static export writes application routes as `/route.html`.
  // Preserve clean URLs so links such as `/borrow/aapl` do not fall back to
  // the landing page.
  if (isInsideOutput && !extname(filePath) && sendFile(request, response, `${filePath}.html`)) return;

  response.writeHead(302, { ...securityHeaders(), Location: "/" }).end();
}).listen(port, "0.0.0.0", () => {
  console.log(`Dockyard frontend listening on port ${port}`);
});
