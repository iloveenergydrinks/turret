import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
export default {
  root: here,
  plugins: [react()],
  server: { host: "127.0.0.1", port: 3033, strictPort: true },
  resolve: {
    alias: [
      ...[
        "wagmi",
        "@/src/env",
        "@/src/deployment-config",
        "@/src/isolated-market-config",
        "@/src/isolated-credit",
        "@/src/isolated-stock-proofs",
        "@/src/screens/DockyardBorrowScreen/BorrowerAlerts",
      ].map((find) => ({ find, replacement: `${here}fixture.tsx` })),
      { find: "@", replacement: fileURLToPath(new URL("../..", import.meta.url)) },
    ],
  },
};
