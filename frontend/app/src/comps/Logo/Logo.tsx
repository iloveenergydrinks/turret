import Image from "next/image";

export function Logo({
  size = 32,
}: {
  size?: number;
}) {
  const assetSize = size;

  return (
    <span
      aria-label="Turret"
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
          src="/brand/turret-mark.svg"
          width={assetSize}
        />
      </span>
      <span className="dockyard-logo-wordmark" style={{ fontSize: size * 0.66 }}>
        turret.
      </span>
    </span>
  );
}
