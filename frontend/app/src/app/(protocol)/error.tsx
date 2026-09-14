"use client";

import { ErrorBox } from "@/src/comps/ErrorBox/ErrorBox";
import { LinkButton } from "@/src/comps/LinkButton/LinkButton";
import { css } from "@/styled-system/css";
import { Button } from "@turret/uikit";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      className={css({
        flexGrow: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        width: "100%",
      })}
    >
      <div
        className={css({
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: "100%",
        })}
      >
        <Illustration />
        <div className={css({ height: 32 })} />
        <h1
          className={css({
            fontSize: 28,
            color: "content",
          })}
        >
          An unexpected error occurred
        </h1>
        <div className={css({ height: 32 })} />
        <div
          className={css({
            display: "flex",
            gap: 16,
          })}
        >
          <LinkButton
            href="/"
            label="Go to dashboard"
            mode="secondary"
          />
          <Button
            label="Reset state"
            mode="primary"
            onClick={reset}
          />
        </div>
        <div className={css({ height: 40 })} />
        <div
          className={css({
            display: "flex",
            maxWidth: 600,
          })}
        >
          <ErrorBox title={`Error: ${error.message}`}>
            <pre>
{error.message}<br /><br />
{error.stack}
            </pre>
          </ErrorBox>
        </div>
      </div>
    </div>
  );
}

function Illustration() {
  return (
    <div
      role="img"
      aria-label="Error"
      className={css({
        display: "grid",
        placeItems: "center",
        width: 104,
        height: 104,
        background: "#FFFFFF",
        border: "1px solid #D8EAE6",
        borderRadius: 32,
        boxShadow: "0 18px 48px rgba(15, 68, 63, 0.12)",
      })}
    >
      <svg
        aria-hidden="true"
        width="64"
        height="64"
        viewBox="0 0 64 64"
        fill="none"
      >
        <circle cx="32" cy="32" r="28" fill="#DDF5F0" />
        <path
          d="M32 17V36"
          stroke="#08786E"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <circle cx="32" cy="46" r="3" fill="#08786E" />
      </svg>
    </div>
  );
}
