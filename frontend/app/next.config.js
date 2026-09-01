import bundleAnalyzer from "@next/bundle-analyzer";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function commitHash(paths) {
  try {
    return String(execSync(
      `git log -1 --pretty=format:%h -- ${paths}`,
      { stdio: ["ignore", "pipe", "ignore"] },
    )).trim();
  } catch {
    return (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "preview").slice(0, 8);
  }
}

const APP_VERSION_FROM_BUILD = JSON.parse(
  readFileSync("./package.json", "utf-8"),
).version;
const APP_COMMIT_HASH_FROM_BUILD = commitHash("./ ../uikit/");
const CONTRACTS_COMMIT_HASH_FROM_BUILD = commitHash("../../contracts/addresses/11155111.json");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  reactStrictMode: false,
  images: { unoptimized: true },
  trailingSlash: flag(process.env.NEXT_TRAILING_SLASH),
  env: {
    APP_VERSION_FROM_BUILD,
    APP_COMMIT_HASH_FROM_BUILD,
    CONTRACTS_COMMIT_HASH_FROM_BUILD,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default (process.env.ANALYZE === "true" ? bundleAnalyzer(nextConfig) : nextConfig);

function flag(value) {
  if (typeof value !== "string") {
    return false;
  }
  value = value.trim();
  return value === "true" || value === "1" || value === "yes";
}
