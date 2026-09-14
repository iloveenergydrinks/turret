"use client";

import type { FocusEvent, ReactNode } from "react";

import { autoUpdate, flip, offset, shift, useFloating } from "@floating-ui/react-dom";
import { a, useTransition } from "@react-spring/web";
import { useEffect, useRef, useState } from "react";
import { css } from "../../styled-system/css";
import { Root } from "../Root/Root";

export function Tooltip({
  children,
  id,
  hideDelay = 200,
  opener,
  placement = "start",
  showDelay = 100,
}: {
  children?: ReactNode;
  id?: string;
  hideDelay?: number;
  opener: (context: {
    visible: boolean;
    buttonProps: {
      onClick: () => void;
      onMouseEnter: () => void;
      onMouseLeave: () => void;
      onFocus: () => void;
      onBlur: (event: FocusEvent<HTMLElement>) => void;
    };
    setReference: (ref: HTMLElement | null) => void;
  }) => ReactNode;
  placement?: "start" | "end";
  showDelay?: number;
}) {
  const [{ visible, autofocus }, setState] = useState({
    visible: false,
    autofocus: false,
  });

  const lastFocused = useRef<HTMLElement | null>(undefined);
  const restoringFocus = useRef(false);
  const hideDelayRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showDelayRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const cancel = () => {
    clearTimeout(hideDelayRef.current);
    clearTimeout(showDelayRef.current);
  };

  const show = (autofocus: boolean, delay: number) => {
    cancel();
    showDelayRef.current = setTimeout(() => {
      if (document.activeElement instanceof HTMLElement) {
        lastFocused.current = document.activeElement;
      }
      setState({ autofocus, visible: true });
    }, delay);
  };

  const hide = (delay: number) => {
    cancel();
    hideDelayRef.current = setTimeout(() => {
      const restoreFocus = floatingRefs.floating.current?.contains(document.activeElement);
      setState({ autofocus: false, visible: false });
      if (restoreFocus) {
        restoringFocus.current = true;
        lastFocused.current?.focus();
        restoringFocus.current = false;
      }
    }, delay);
  };

  useEffect(() => cancel, []);

  useKeyboardNavigation({
    onClose: () => hide(0),
    visible,
  });

  const { refs: floatingRefs, floatingStyles } = useFloating({
    placement: `bottom-${placement}`,
    open: visible,
    whileElementsMounted: (referenceEl, floatingEl, update) => (
      autoUpdate(referenceEl, floatingEl, update, {
        layoutShift: false,
        animationFrame: false,
      })
    ),
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({
        crossAxis: true,
        padding: 8,
      }),
    ],
    transform: false,
  });

  const transition = useTransition(visible, {
    from: {
      opacity: 0,
      transform: "scale(0.97)",
    },
    enter: {
      opacity: 1,
      transform: "scale(1)",
    },
    leave: {
      opacity: 0,
      transform: "scale(1)",
    },
    config: {
      mass: 1,
      tension: 4000,
      friction: 80,
    },
  });

  return (
    <>
      {opener({
        visible,
        buttonProps: {
          onClick: () => show(true, 0),
          onMouseEnter: () => show(false, showDelay),
          onMouseLeave: () => hide(hideDelay),
          onFocus: () => { if (!restoringFocus.current) show(false, showDelay); },
          onBlur: (event) => { if (!floatingRefs.floating.current?.contains(event.relatedTarget)) hide(hideDelay); },
        },
        setReference: floatingRefs.setReference,
      })}
      <Root>
        {transition((transitionStyles, visible) => (
          visible && (
            <a.div
              id={id}
              role="tooltip"
              ref={floatingRefs.setFloating}
              onMouseEnter={() => cancel()}
              onMouseLeave={() => hide(hideDelay)}
              className={css({
                position: "absolute",
                zIndex: 1,
                top: 0,
                left: 0,
                width: "100%",
                maxWidth: 300,
              })}
              style={{
                ...transitionStyles,
                ...floatingStyles,
              }}
            >
              <TooltipPopup
                autofocus={autofocus}
                onHide={() => hide(0)}
              >
                {children}
              </TooltipPopup>
            </a.div>
          )
        ))}
      </Root>
    </>
  );
}

function TooltipPopup({
  autofocus,
  children,
  onHide,
}: {
  autofocus: boolean;
  children?: ReactNode;
  onHide: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autofocus) {
      ref.current?.focus();
    }
  }, [autofocus]);

  return (
    <section
      ref={ref}
      tabIndex={0}
      onBlur={({ currentTarget, relatedTarget }) => {
        if (!currentTarget.contains(relatedTarget)) {
          onHide();
        }
      }}
      className={css({
        padding: "12px 12px 16px",
        background: "background",
        border: "1px solid token(colors.border)",
        borderRadius: 4,
        boxShadow: `
          0 15px 35px rgba(60, 66, 87, 0.12),
          0  5px 15px rgba(0,  0,  0,  0.08)
        `,
        _focusVisible: {
          outlineOffset: -1,
          outline: "2px solid token(colors.focused)",
        },
      })}
    >
      {children}
    </section>
  );
}

function useKeyboardNavigation({
  onClose,
  visible,
}: {
  onClose: () => void;
  visible: boolean;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!visible) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, visible]);
}
