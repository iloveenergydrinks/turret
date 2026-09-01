export function Logo({
  size = 32,
}: {
  size?: number;
}) {
  return (
    <span
      className="dockyard-logo"
      style={{ height: size }}
    >
      <span className="dockyard-logo-wordmark" style={{ fontSize: size * 0.66 }}>
        Dockyard
      </span>
    </span>
  );
}
