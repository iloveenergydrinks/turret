import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const outputDirectory = resolve(fileURLToPath(new URL("../out/", import.meta.url)));
const port = Number.parseInt(process.env.PORT || "3000", 10);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
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
      "connect-src 'none'",
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

  response.writeHead(200, {
    ...securityHeaders(),
    "Cache-Control": filePath.includes(`${sep}_next${sep}static${sep}`)
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300",
    "Content-Length": stats.size,
    "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
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

  const allowedAsset = pathname.startsWith("/_next/static/") || /^\/[\w.-]+\.(svg|png|ico|woff2?)$/.test(pathname);
  const filePath = resolve(outputDirectory, `.${pathname}`);
  if (allowedAsset && filePath.startsWith(`${outputDirectory}${sep}`) && sendFile(request, response, filePath)) return;

  response.writeHead(302, { ...securityHeaders(), Location: "/" }).end();
}).listen(port, "0.0.0.0", () => {
  console.log(`rUSD MVP preview listening on port ${port}`);
});
