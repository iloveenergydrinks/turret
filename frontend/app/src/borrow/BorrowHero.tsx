"use client";

import { HowBorrowingWorks, HowP2PWorks } from "../comps/HowBorrowingWorks/HowBorrowingWorks";
import { TurretModel } from "./TurretModel";
import styles from "./BorrowHero.module.css";
import type { BorrowTab } from "./BorrowExperienceContext";

/** Shared borrowing introduction with an interactive architectural tower. */
export function BorrowHero({ theme = "p2p" }: { theme?: BorrowTab }) {
  return <section className={styles.hero} aria-label="Borrow with Turret">
    <div className={styles.message}>
      <h1>Borrow against memecoins, stocks and NFTs</h1>
      <p className={styles.copy}>Borrow USDG against supported assets without selling them. Choose a pool loan or agree terms directly with a lender on Robinhood Chain.</p>
      <div className={styles.videos} aria-label="Loan explainers">
        <HowBorrowingWorks />
        <HowP2PWorks />
      </div>
    </div>
    <figure className={styles.figure}>
      <TurretModel theme={theme} />
    </figure>
  </section>;
}
