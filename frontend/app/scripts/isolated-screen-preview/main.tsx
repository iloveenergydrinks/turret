import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/figtree";
import "../../src/app/brand.css";
import type { IsolatedMarket } from "../../src/isolated-market-config";
import { IsolatedMarketScreen } from "../../src/screens/IsolatedMarketScreen/IsolatedMarketScreen";
import { market } from "./fixture";
createRoot(document.getElementById("root")!).render(
  <div style={{ padding: "0 20px" }}>
    <p style={{ fontSize: 14 }}>Local interface fixture — simulated balances. No transactions.</p>
    <IsolatedMarketScreen
      market={market as IsolatedMarket}
      mode={new URLSearchParams(location.search).get("mode") === "borrow" ? "borrow" : "earn"}
    />
  </div>,
);
