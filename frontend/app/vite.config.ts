import type { ViteUserConfig } from "vitest/config";

import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// Public defaults only; unit tests must not load operator credentials.
const defaults = parseEnv(readFileSync(new URL("./.env.example", import.meta.url), "utf8"));
for (const [key, value] of Object.entries(defaults)) {
  if (key.startsWith("NEXT_PUBLIC_") && process.env[key] === undefined) process.env[key] = value;
}

export default defineConfig({
  plugins: [
    tsconfigPaths(),
    react(),
  ] as NonNullable<ViteUserConfig["plugins"]>,
  test: {
    // Server scripts use node:test and run separately via test:server.
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      include: [
        "src/formatting.ts",
        "src/liquity-math.ts",
      ],
    },
    server: {
      deps: {
        inline: [
          "@floating-ui/react-dom",
          "@floating-ui/dom",
          "@floating-ui/core",
          "@floating-ui/utils",
          "focus-trap-react",
          "prop-types",
          "react-is",
          "object-assign",
          "focus-trap",
          "tabbable",
          "blo",
        ],
      },
    },
  },
  resolve: {
    alias: {
      "@": __dirname,
    },
  },
});
