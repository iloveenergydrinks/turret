import { useEffect, useId, useRef, type ReactNode } from "react";
import "./RequestLoanDialog.css";

/** Keeps both loan entry flows on the marketplace, with native focus containment. */
export function LoanActionDialog({ title, closeLabel, busy = false, onClose, children }: {
  title: string; closeLabel: string; busy?: boolean; onClose: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement as HTMLElement | null;
    const overflow = document.documentElement.style.overflow;
    element.showModal();
    document.documentElement.style.overflow = "hidden";
    return () => {
      element.close();
      document.documentElement.style.overflow = overflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  return <dialog ref={dialog} className="p2p-request-dialog p2p-borrower-requests" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="p2p-request-dialog-heading">
      <h2 id={titleId}>{title}</h2>
      <button className="p2p-button p2p-secondary" aria-label={closeLabel} disabled={busy} onClick={onClose}>Close</button>
    </header>
    {children}
  </dialog>;
}
