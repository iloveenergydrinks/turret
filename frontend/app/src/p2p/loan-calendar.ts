type CalendarMarket = {
  chainId: number; address: string; loanSymbol: string; collateralSymbol: string;
  loanDecimals: number; collateralDecimals: number;
};
type CalendarLoan = {
  id: bigint; status: string; dueAt: number; repaymentDeadline?: number; principal: bigint; interest: bigint; collateral: bigint;
};
type CalendarInput = { market: CalendarMarket; loan: CalendarLoan; url: string; now?: number };

const graceSeconds = 86_400;
const lastCalendarSecond = 253_402_300_799; // 9999-12-31T23:59:59Z, the last four-digit iCalendar year.
const maxUint256 = (1n << 256n) - 1n;
const encoder = new TextEncoder();

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= lastCalendarSecond;
}

function utc(value: number): string {
  return new Date(value * 1_000).toISOString().replace(/[-:]/g, "").replace(".000", "");
}

function text(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r\n|[\r\n\u2028\u2029]/g, "\\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/;/g, "\\;").replace(/,/g, "\\,");
}

function amount(value: bigint, decimals: number): string {
  const digits = value.toString().padStart(decimals + 1, "0");
  if (decimals === 0) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}

// RFC 5545 content lines use CRLF and at most 75 UTF-8 octets, including a continuation's space.
function fold(line: string): string {
  const lines: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (bytes + size > 75) {
      lines.push(current);
      current = " ";
      bytes = 1;
    }
    current += character;
    bytes += size;
  }
  lines.push(current);
  return lines.join("\r\n");
}

/** Builds a download only. `now` is Unix seconds; imported reminders do not update automatically. */
export function loanCalendar({ market, loan, url, now = Math.floor(Date.now() / 1_000) }: CalendarInput): {
  filename: string; content: string;
} | null {
  const finalDeadline = loan.repaymentDeadline ?? loan.dueAt + graceSeconds;
  if (loan.status !== "active" || !validTime(loan.dueAt) || loan.dueAt === 0
    || !validTime(finalDeadline) || finalDeadline < loan.dueAt + graceSeconds || !validTime(now)) return null;
  if (!Number.isSafeInteger(market.chainId) || market.chainId <= 0
    || !/^0x[0-9a-f]{40}$/i.test(market.address) || /^0x0{40}$/i.test(market.address)
    || typeof loan.id !== "bigint" || loan.id <= 0n || loan.id > maxUint256
    || ![market.loanDecimals, market.collateralDecimals].every(value => Number.isInteger(value) && value >= 0 && value <= 36)
    || ![market.loanSymbol, market.collateralSymbol].every(value => typeof value === "string" && value.trim().length > 0 && value.length <= 512)
    || ![loan.principal, loan.interest, loan.collateral].every(value => typeof value === "bigint" && value >= 0n && value <= maxUint256)
    || loan.principal === 0n || loan.collateral === 0n || loan.principal + loan.interest > maxUint256) return null;

  // URL parsers strip some raw controls. Reject them before parsing to prevent content-line injection.
  if (typeof url !== "string" || /[\u0000-\u0020\u007f]/.test(url)) return null;
  let link: URL;
  try { link = new URL(url); } catch { return null; }
  if (!["https:", "http:"].includes(link.protocol) || !link.hostname) return null;

  const escrow = market.address.toLowerCase();
  const identity = `${market.chainId}-${escrow}-${loan.id}`;
  const title = `Turret ${market.collateralSymbol} loan #${loan.id}`;
  const repayment = `${amount(loan.principal + loan.interest, market.loanDecimals)} ${market.loanSymbol}`;
  const description = [
    `Fixed repayment: ${repayment} (principal ${amount(loan.principal, market.loanDecimals)} + fixed interest ${amount(loan.interest, market.loanDecimals)} ${market.loanSymbol}).`,
    `Collateral at risk: ${amount(loan.collateral, market.collateralDecimals)} ${market.collateralSymbol}.`,
    `Due: ${new Date(loan.dueAt * 1_000).toISOString()}.`,
    `Final repayment deadline: ${new Date(finalDeadline * 1_000).toISOString()}${finalDeadline > loan.dueAt + graceSeconds ? " (extended by mutual agreement)" : " (24 hours after due)"}.`,
    "Repay by the final deadline to recover collateral. After that deadline, all collateral may be assigned to the lender.",
    "Network, wallet or website outages do not extend the on-chain deadline.",
    "This downloaded reminder does not update automatically after repayment or settlement. It also does not track deadline extensions. Download a new reminder after agreeing an extension.",
    `Chain: ${market.chainId}. Escrow: ${escrow}. Loan: ${loan.id}.`,
    `Loan URL: ${link.href}`,
  ].join("\n");
  const event = (kind: "due" | "deadline", start: number, summary: string): string[] => [
    "BEGIN:VEVENT",
    `UID:turret-p2p-${identity}-${kind}@turret.capital`,
    `DTSTAMP:${utc(now)}`,
    `DTSTART:${utc(start)}`,
    `SUMMARY:${text(summary)}`,
    `DESCRIPTION:${text(description)}`,
    `URL:${link.href}`,
    "TRANSP:TRANSPARENT",
  ];
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Turret//P2P Loan Reminders//EN", "CALSCALE:GREGORIAN",
    ...event("due", loan.dueAt, `${title}: due`), "END:VEVENT",
    ...event("deadline", finalDeadline, `${title}: final repayment deadline`),
  ];
  for (const trigger of ["-P1D", "-PT1H"]) {
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER;RELATED=START:${trigger}`,
      `DESCRIPTION:${text(`${title}: repay ${repayment} by the final deadline to recover collateral. Outages do not extend the deadline. ${link.href}`)}`,
      "END:VALARM");
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return { filename: `turret-loan-${identity}.ics`, content: `${lines.map(fold).join("\r\n")}\r\n` };
}
