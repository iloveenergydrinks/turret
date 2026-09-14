/** Wallet providers may reject with plain RPC objects rather than Error instances. */
export function nftErrorText(error: unknown): string {
  const queue: unknown[] = [error], seen = new Set<unknown>();
  let message = "";
  for (let i = 0; i < queue.length && i < 12; i++) {
    const item = queue[i];
    if (!item || seen.has(item)) continue;
    seen.add(item);
    if (typeof item === "string") { if (!message) message = item; continue; }
    if (typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const code = typeof value.code === "number" || typeof value.code === "string" ? Number(value.code) : NaN;
    if (code === 4001) return "Wallet request declined. Review the action and try again when ready.";
    if (code === -32002) return "A request is already open in your wallet. Open the wallet and complete or dismiss it before trying again.";
    if (code === 4100) return "Your wallet has not authorized this connection. Reconnect the wallet to continue.";
    if (code === 4900 || code === 4901) return "Your wallet is disconnected from the required network. Connect to Robinhood Chain and try again.";
    if (!message) {
      const text = typeof value.shortMessage === "string" ? value.shortMessage : value.message;
      if (typeof text === "string") message = text;
    }
    queue.push(value.cause, value.data, value.originalError);
  }
  return message.trim().replace(/\s+/g, " ").slice(0, 360)
    || "The action could not be confirmed. Check your wallet’s activity before trying again.";
}
