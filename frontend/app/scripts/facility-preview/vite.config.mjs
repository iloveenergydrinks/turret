import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({ root, publicDir: fileURLToPath(new URL("../../public", import.meta.url)), plugins: [react()],
  server: { host: "127.0.0.1", port: 4312, strictPort: true, fs: { allow: [fileURLToPath(new URL("../../../..", import.meta.url))] } },
  build: { outDir: fileURLToPath(new URL("../../../../output/memecoin-switch-20260912/facility-preview-build", import.meta.url)), emptyOutDir: true },
});
