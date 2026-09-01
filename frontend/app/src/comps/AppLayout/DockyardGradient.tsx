"use client";

import { MeshGradient } from "@paper-design/shaders-react";
import { useEffect, useState } from "react";

const DOCKYARD_GRADIENT = [
  "#f5fbfa",
  "#c4efe6",
  "#a4dfd3",
  "#c9def3",
  "#f5e8c3",
];

export function DockyardGradient() {
  const [reduceMotion, setReduceMotion] = useState(true);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPreference = () => setReduceMotion(query.matches);

    syncPreference();
    query.addEventListener("change", syncPreference);
    return () => query.removeEventListener("change", syncPreference);
  }, []);

  return (
    <div aria-hidden="true" className="dockyard-gradient">
      <MeshGradient
        colors={DOCKYARD_GRADIENT}
        distortion={0.72}
        fit="cover"
        frame={18000}
        grainMixer={0.08}
        grainOverlay={0.015}
        height="100dvh"
        maxPixelCount={1_600_000}
        minPixelRatio={1}
        scale={1.15}
        speed={reduceMotion ? 0 : 0.035}
        swirl={0.18}
        width="100vw"
      />
    </div>
  );
}
