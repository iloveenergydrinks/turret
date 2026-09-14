import type { ComponentPropsWithRef } from "react";

import content from "@/src/content";
import { WalletAvatar } from "@/src/profiles/WalletAvatar";
import { IconChevronDown, shortenAddress, ShowAfter } from "@turret/uikit";
import { a, useTransition } from "@react-spring/web";
import { ConnectKitButton } from "connectkit";
import { match, P } from "ts-pattern";
import { useSwitchChain } from "wagmi";

export function AccountButton() {
  return (
    <ShowAfter delay={500}>
      <ConnectKitButton.Custom>
        {(props) => <CKButton {...props} />}
      </ConnectKitButton.Custom>
    </ShowAfter>
  );
}

function CKButton({
  chain,
  isConnected,
  isConnecting,
  address,
  ensName,
  show,
}: Parameters<
  NonNullable<
    ComponentPropsWithRef<
      typeof ConnectKitButton.Custom
    >["children"]
  >
>[0]) {
  const status = match({ chain, isConnected, isConnecting, address })
    .returnType<
      | { mode: "connected"; address: `0x${string}` }
      | { mode: "connecting" | "disconnected" | "unsupported"; address?: never }
    >()
    .with(
      P.union(
        { chain: { unsupported: true } },
        { isConnected: true, chain: P.nullish },
      ),
      () => ({ mode: "unsupported" }),
    )
    .with({ isConnected: true, address: P.nonNullable }, ({ address }) => ({
      address,
      mode: "connected",
    }))
    .with({ isConnecting: true }, () => ({ mode: "connecting" }))
    .otherwise(() => ({ mode: "disconnected" }));

  const transition = useTransition(status, {
    keys: ({ mode }) => String(mode === "connected"),
    from: { opacity: 0, transform: "scale(0.9)" },
    enter: { opacity: 1, transform: "scale(1)" },
    leave: { opacity: 0, display: "none", immediate: true },
    config: { mass: 1, tension: 2400, friction: 80 },
  });

  return transition((spring, { mode, address }) => {
    const containerProps = {
      className: "dockyard-wallet-control",
      style: spring,
    } as const;
    return mode === "connected"
      ? (
        <a.div {...containerProps}>
          <ButtonConnected
            address={address}
            label={ensName ?? shortenAddress(address, 4)}
            onClick={show}
            title={address}
          />
        </a.div>
      )
      : (
        <a.div {...containerProps}>
          <ButtonNotConnected
            mode={mode}
            show={show}
          />
        </a.div>
      );
  });
}

function ButtonNotConnected({
  mode,
  show,
}: {
  mode: "connecting" | "disconnected" | "unsupported";
  show?: () => void;
}) {
  const { switchChain, chains } = useSwitchChain();

  const props = {
    label: mode === "connecting"
      ? "Connecting…"
      : mode === "unsupported"
      ? content.accountButton.wrongNetwork
      : content.accountButton.connectAccount,
    onClick: mode === "unsupported"
      ? () => {
        switchChain({ chainId: chains[0].id });
      }
      : show,
  } as const;

  return (
    <button
      aria-busy={mode === "connecting"}
      className="dockyard-wallet-button"
      data-state={mode}
      disabled={mode === "connecting"}
      onClick={props.onClick}
      type="button"
    >
      <span className="dockyard-wallet-label">{props.label}</span>
    </button>
  );
}

function ButtonConnected({
  address,
  label,
  onClick,
  title,
}: {
  address: string;
  label: string;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      aria-label={`Open wallet menu for ${title ?? label}`}
      aria-haspopup="dialog"
      onClick={onClick}
      title={title}
      type="button"
      className="dockyard-wallet-button"
      data-state="connected"
    >
      <WalletAvatar address={address} size={22} />
      <span className="dockyard-wallet-label">{label}</span>
      <span aria-hidden="true" className="dockyard-wallet-chevron">
        <IconChevronDown size={14} />
      </span>
    </button>
  );
}
