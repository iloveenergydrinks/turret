"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { match, P } from "ts-pattern";
import { css, cx } from "../../styled-system/css";
import { useTheme } from "../Theme/Theme";

export type ButtonProps = {
  label: ReactNode;
  maxWidth?: number;
  mode?: "primary" | "secondary" | "tertiary" | "positive" | "negative";
  shape?: "rounded" | "rectangular";
  size?: "mini" | "small" | "medium" | "large";
  wide?: boolean;
};

export function Button({
  className,
  label,
  maxWidth,
  mode = "secondary",
  shape = "rounded",
  size = "medium",
  style,
  wide,
  ...props
}: ComponentPropsWithoutRef<"button"> & ButtonProps) {
  const buttonStyles = useButtonStyles({ mode, shape, size });
  return (
    <button
      className={cx(buttonStyles.className, className)}
      style={{
        maxWidth,
        width: wide ? "100%" : undefined,
        ...buttonStyles.styles,
        ...style,
      }}
      {...props}
    >
      <span
        style={{
          // prevents a jump due to the border when the button gets disabled
          padding: props.disabled ? 0 : "0 1px",
        }}
      >
        {label}
      </span>
    </button>
  );
}

export function useButtonStyles({
  mode = "secondary",
  size = "medium",
  shape = "rounded",
}: {
  mode: ButtonProps["mode"];
  size: ButtonProps["size"];
  shape: ButtonProps["shape"];
}) {
  const { color } = useTheme();

  const geometry = match(size)
    .with("mini", () => ({
      height: 30,
      padding: "0 10px",
      fontSize: 12,
      borderRadius: 8,
    }))
    .with("small", () => ({
      height: 38,
      padding: "0 14px",
      fontSize: 13,
      borderRadius: 10,
    }))
    .with("medium", () => ({
      height: 44,
      padding: "0 18px",
      fontSize: 14,
      borderRadius: shape === "rectangular" ? 10 : 12,
    }))
    .with("large", () => ({
      height: 64,
      padding: "0 24px",
      fontSize: 18,
      borderRadius: shape === "rectangular" ? 12 : 16,
    }))
    .exhaustive();

  const colors = match(mode)
    .with("primary", () => ({
      "--color": color("accentContent"),
      "--background": color("accent"),
      "--backgroundHover": color("accentActive"),
      "--backgroundPressed": "color-mix(in srgb, var(--backgroundHover) 88%, black)",
      "--border": "transparent",
      "--shadow": "0 5px 16px rgba(5, 103, 95, 0.16)",
      "--shadowHover": "0 8px 22px rgba(5, 103, 95, 0.22)",
    }))
    .with(P.union("secondary", "tertiary"), (mode) => ({
      "--color": color("secondaryContent"),
      "--background": mode === "secondary" ? color("secondary") : "transparent",
      "--backgroundHover": color("secondaryHint"),
      "--backgroundPressed": color("secondaryActive"),
      "--border": mode === "secondary"
        ? "color-mix(in srgb, var(--color) 18%, transparent)"
        : "transparent",
      "--shadow": "none",
      "--shadowHover": "none",
    }))
    .with("negative", () => ({
      "--color": color("negativeContent"),
      "--background": color("negative"),
      "--backgroundHover": color("negativeHint"),
      "--backgroundPressed": color("negativeActive"),
      "--border": "transparent",
      "--shadow": "none",
      "--shadowHover": "none",
    }))
    .with("positive", () => ({
      "--color": color("positiveContent"),
      "--background": color("positive"),
      "--backgroundHover": color("positiveHint"),
      "--backgroundPressed": color("positiveActive"),
      "--border": "transparent",
      "--shadow": "none",
      "--shadowHover": "none",
    }))
    .exhaustive();

  const className = css({
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    whiteSpace: "nowrap",
    cursor: "pointer",
    fontWeight: 700,
    letterSpacing: "-0.01em",
    border: "1px solid var(--border)",
    boxShadow: "var(--shadow)",
    transition:
      "background 160ms cubic-bezier(0.16, 1, 0.3, 1), color 160ms ease-out, border-color 160ms ease-out, box-shadow 160ms ease-out, translate 160ms cubic-bezier(0.16, 1, 0.3, 1)",
    color: "var(--color)",
    textDecoration: "none",
    background: {
      base: "var(--background)",
      _hover: "var(--backgroundHover)",
      _active: "var(--backgroundPressed)",
    },
    _hover: {
      _enabled: {
        boxShadow: "var(--shadowHover)",
        translate: "0 -1px",
      },
    },
    _active: {
      _enabled: {
        translate: "0 1px",
      },
    },
    _focusVisible: {
      outline: "3px solid color-mix(in srgb, token(colors.focused) 32%, transparent)",
      outlineOffset: "3px!",
    },
    _disabled: {
      color: "disabledContent",
      background: {
        base: "disabledSurface",
        _hover: "disabledSurface",
        _active: "disabledSurface",
      },
      cursor: "not-allowed",
      border: "1px solid token(colors.disabledBorder)",
      boxShadow: "none",
      translate: "none",
    },
  });

  return {
    className,
    styles: {
      ...geometry,
      ...colors,

      outlineOffset: 3,
    },
  };
}
