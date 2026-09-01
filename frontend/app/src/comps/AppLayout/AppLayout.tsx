"use client";

import type { ReactNode } from "react";

import { Banner } from "@/Banner";
import { LegacyPositionsBanner } from "@/src/comps/LegacyPositionsBanner/LegacyPositionsBanner";
import { SafetyModeBanner } from "@/src/comps/SafetyModeBanner/SafetyModeBanner";
import { ShutdownModeBanner } from "@/src/comps/ShutdownModeBanner/ShutdownModeBanner";
import { SubgraphDownBanner } from "@/src/comps/SubgraphDownBanner/SubgraphDownBanner";
import { V1StabilityPoolBanner } from "@/src/comps/V1StabilityPoolBanner/V1StabilityPoolBanner";
import { V1StakingBanner } from "@/src/comps/V1StakingBanner/V1StakingBanner";
import { LEGACY_CHECK, SAFETY_MODE_CHECK, SUBGRAPH_CHECK, V1_STABILITY_POOL_CHECK, V1_STAKING_CHECK } from "@/src/env";
import { BottomBar } from "./BottomBar";
import { TopBar } from "./TopBar";

export const LAYOUT_WIDTH = 1040;

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="rusd-shell">
      {V1_STAKING_CHECK && <V1StakingBanner />}
      {V1_STABILITY_POOL_CHECK && <V1StabilityPoolBanner />}
      {LEGACY_CHECK && <LegacyPositionsBanner />}
      {SUBGRAPH_CHECK && <SubgraphDownBanner />}
      {SAFETY_MODE_CHECK && <SafetyModeBanner />}
      {SAFETY_MODE_CHECK && <ShutdownModeBanner />}
      <Banner />
      <TopBar />
      <main className="rusd-frame rusd-main">{children}</main>
      <BottomBar />
    </div>
  );
}
