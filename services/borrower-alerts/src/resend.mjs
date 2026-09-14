export const DEFAULT_EMAIL_FROM = "Turret <alerts@turret.capital>";

export function emailSubject(text) {
  if (text.startsWith('Confirm Turret NFT P2P')) return 'Confirm your Turret NFT loan alerts';
  if (text.startsWith('Turret NFT P2P: ')) return text.split('\n',1)[0].slice(0,160);
  if (text.startsWith('Confirm Turret P2P')) return 'Confirm your Turret P2P email alerts';
  if (text.startsWith('Turret P2P: ')) return text.split('\n',1)[0].slice(0,160);
  if (text.startsWith("Confirm Turret") || text.startsWith("Confirm Dockyard")) return "Confirm your Turret email alerts";
  if (text.includes("liquidation-eligible")) return "Urgent: your Turret loan is liquidation-eligible";
  if (text.includes("critically close")) return "Urgent: your Turret loan is close to liquidation";
  if (text.includes("approaching liquidation")) return "Warning: your Turret loan is approaching liquidation";
  if (text.includes("liquidation confirmed")) return "Turret liquidation confirmed";
  if (text.includes("Risk data unavailable")) return "Turret: position risk data unavailable";
  if (text.includes("back below") || text.includes("No debt remains")) return "Turret: position risk update";
  if (text.includes("failed on-chain")) return "Turret transaction failed";
  return "Your Turret borrower alerts are connected";
}

export async function sendEmail({ key, from = DEFAULT_EMAIL_FROM, to, text, id, fetcher = fetch }) {
  if (!key) throw new Error("Email channel not configured");
  let response;
  try {
    response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": id },
      body: JSON.stringify({ from, to: [to], subject: emailSubject(text), text }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error();
    const result = await response.json();
    if (!result.id) throw new Error();
  } catch {
    // Strip SDK/fetch errors: they can include secrets or private message bodies.
    throw new Error("Email provider did not confirm acceptance");
  }
}
