"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./HowBorrowingWorks.module.css";

export function HowBorrowingWorks() {
  return <HowItWorksVideo title="How borrowing works" description="How borrowing with Turret works"
    basename="dockyard-how-borrowing-works-v1" seconds={35} />;
}

export function HowP2PWorks() {
  return <HowItWorksVideo title="How P2P loans work" description="How P2P borrowing and lending with Turret works"
    basename="turret-how-p2p-works-v1" seconds={54} />;
}

function HowItWorksVideo({ title, description, basename, seconds }: {
  title: string;
  description: string;
  basename: string;
  seconds: number;
}) {
  const videoUrl = `/videos/${basename}.mp4`;
  const [isOpen, setIsOpen] = useState(false);
  const [hasError, setHasError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!isOpen || !element) return;

    const previousOverflow = document.documentElement.style.overflow;
    element.showModal();
    document.documentElement.style.overflow = "hidden";

    return () => {
      element.close();
      document.documentElement.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  return (
    <div className={styles.action}>
      <button
        aria-haspopup="dialog"
        className={`rusd-text-link ${styles.trigger}`}
        onClick={() => {
          setHasError(false);
          setIsOpen(true);
        }}
        type="button"
      >
        <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
          <path d="m10 8 6 4-6 4Z" fill="currentColor" />
        </svg>
        {title}
      </button>
      <dialog
        aria-labelledby={titleId}
        className={styles.dialog}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left || event.clientX > bounds.right
            || event.clientY < bounds.top || event.clientY > bounds.bottom
          ) setIsOpen(false);
        }}
        onClose={() => setIsOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setIsOpen(false);
          }
        }}
        ref={dialog}
      >
        {isOpen && (
          <>
            <header className={styles.header}>
              <h2 id={titleId}>{title}</h2>
              <button
                aria-label="Close video"
                className={styles.close}
                onClick={() => setIsOpen(false)}
                type="button"
              >
                <svg aria-hidden="true" fill="none" height="24" viewBox="0 0 24 24" width="24">
                  <path d="m6 6 12 12M6 18 18 6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
                </svg>
              </button>
            </header>
            <video
              aria-label={description}
              autoPlay
              className={styles.video}
              controls
              height="1080"
              onError={() => setHasError(true)}
              playsInline
              poster={`/videos/${basename}.jpg`}
              preload="metadata"
              src={videoUrl}
              width="1920"
            >
              <track
                kind="captions"
                label="English"
                src={`/videos/${basename}.vtt`}
                srcLang="en"
              />
              Your browser cannot play this video. Use the download link below.
            </video>
            <footer className={styles.footer}>
              {hasError
                ? <p role="alert">The video couldn’t load. Try downloading it instead.</p>
                : <p>{seconds} seconds · Captioned</p>}
              <a download href={videoUrl}>Download video</a>
            </footer>
          </>
        )}
      </dialog>
    </div>
  );
}
