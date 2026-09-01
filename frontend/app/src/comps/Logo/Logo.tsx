import Image from "next/image";

export function Logo({
  size = 32,
}: {
  size?: number;
}) {
  const assetSize = Math.round(size * 1.48);

  return (
    <span
      aria-label="Dockyard"
      className="dockyard-logo"
      role="img"
      style={{ height: size }}
    >
      <span
        aria-hidden="true"
        className="dockyard-logo-mark-frame"
        style={{ height: size, width: size }}
      >
        <Image
          alt=""
          className="dockyard-logo-mark"
          height={assetSize}
          priority
          src="/brand/dockyard-safe-harbor-ai.png"
          width={assetSize}
        />
      </span>
      <span className="dockyard-logo-wordmark" style={{ fontSize: size * 0.66 }}>
        dockyard.
      </span>
    </span>
  );
}
