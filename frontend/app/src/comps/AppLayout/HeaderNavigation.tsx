"use client";

import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";

export function HeaderNavigation({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [open]);

  return (
    <div className="dockyard-header-navigation" ref={container}>
      <button
        aria-controls={id}
        aria-expanded={open}
        aria-label={open ? "Close navigation" : "Open navigation"}
        className="dockyard-nav-toggle"
        onClick={() => setOpen(!open)}
        ref={toggle}
        type="button"
      >
        <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20">
          <path d={open ? "M6 6l12 12M6 18L18 6" : "M4 6h16M4 12h16M4 18h16"} stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      </button>
      {/* Native links emit clicks for pointer and keyboard activation; this only dismisses their disclosure. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events */}
      <nav
        aria-label="Primary"
        className="rusd-nav"
        data-open={open}
        id={id}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("a")) setOpen(false);
        }}
      >
        {children}
      </nav>
    </div>
  );
}
