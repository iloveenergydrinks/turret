"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { mountTurret } from "./turret/scene";
import styles from "./BorrowHero.module.css";
import type { BorrowTab } from "./BorrowExperienceContext";

// Inline the existing brand/turret-mark.svg so the loader has no image request of its own.
function TurretMark() {
  return <svg viewBox="0 0 524 524" width="64" height="64" fill="currentColor" aria-hidden="true">
    <path d="M21 0h108v86h74V0h117v86h75V0h108v524H303V378h-82v146H21Z" />
  </svg>;
}

const sceneLabels: Record<BorrowTab, string> = {
  p2p: "Two little knight mascots exchanging collateral and USDG through a loan cycle",
  nfts: "Knight mascots borrowing USDG against a framed collectible in a square NFT vault",
  pools: "Knight lenders supplying a shared treasury while a borrower receives a pool loan",
};

export function TurretModel({ theme = "p2p" }: { theme?: BorrowTab }) {
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<ReturnType<typeof mountTurret> | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [reduced, setReduced] = useState(true);
  const instructionsId = useId();

  useEffect(() => {
    let cancelled = false;
    // A slow or unsupported WebGL runtime must never hold the website closed.
    const timeout = window.setTimeout(() => setLoading(false), 10000);
    const finishLoading = (sceneReady: boolean) => {
      if (cancelled) return;
      window.clearTimeout(timeout);
      setReady(sceneReady);
      setLoading(false);
    };
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPreference = () => setReduced(preference.matches);
    syncPreference();
    preference.addEventListener("change", syncPreference);
    // Keep the 3D runtime outside the initial page bundle.
    import("./turret/scene").then(({ mountTurret }) => {
      if (cancelled || !canvasRef.current) return;
      sceneRef.current = mountTurret(canvasRef.current, () => finishLoading(true), () => finishLoading(false), themeRef.current);
      sceneRef.current.setMotion(pausedRef.current, preference.matches);
    }).catch(() => finishLoading(false));
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      preference.removeEventListener("change", syncPreference);
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => { sceneRef.current?.setTheme(theme); }, [theme]);

  useEffect(() => {
    pausedRef.current = paused;
    sceneRef.current?.setMotion(paused, reduced);
  }, [paused, reduced]);

  return <>
    <noscript><style>{`.${styles.pageLoader} { display: none; }`}</style></noscript>
    <div className={styles.pageLoader} data-loading={loading} aria-hidden={!loading}>
      <div role="status" className={styles.loaderMark}>
        <TurretMark />
        <span className={styles.screenReaderOnly}>Loading Turret</span>
      </div>
    </div>
    <div className={styles.loanDemo}>
    <div className={styles.sculpture} data-ready={ready}>
    {!ready && <div className={styles.unavailableMark} role="img" aria-label="Turret">
      <TurretMark />
    </div>}
    <canvas ref={canvasRef} className={styles.canvas} data-ready={ready} data-theme={theme} tabIndex={ready ? 0 : -1}
      aria-hidden={!ready}
      role="img" aria-label={sceneLabels[theme]} aria-describedby={ready ? instructionsId : undefined} />
    {ready && <span id={instructionsId} className={styles.screenReaderOnly}>Use left and right arrow keys to turn the tower, or Home to reset.</span>}
    {ready && !reduced && <button type="button" className={styles.motionControl}
      onClick={() => setPaused(!paused)} aria-label={paused ? "Play tower animation" : "Pause tower animation"}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
        {paused ? <path d="m5 3 7 5-7 5V3Z" fill="currentColor" /> : <path d="M5 3v10M11 3v10" stroke="currentColor" strokeWidth="1.5" />}
      </svg>
    </button>}
    </div>
  </div>
  </>;
}
