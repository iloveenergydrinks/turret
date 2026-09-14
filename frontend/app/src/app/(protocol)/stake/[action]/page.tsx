// Preserve stake/rewards links without exposing the inherited Liquity governance screen.
export function generateStaticParams() {
  return [{ action: "deposit" }, { action: "rewards" }, { action: "unstake" }, { action: "legacy" }];
}
export default function Page() { return null; }
