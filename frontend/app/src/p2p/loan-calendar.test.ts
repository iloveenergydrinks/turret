import { describe, expect, it, vi } from "vitest";
import { loanCalendar } from "./loan-calendar";

const second = (value: string) => Date.parse(value) / 1_000;
const market = {
  chainId: 4663, address: "0xabcdef1234567890abcdef1234567890abcdef12",
  loanSymbol: "USDG", loanDecimals: 6, collateralSymbol: "AAPL", collateralDecimals: 18,
};
const loan = {
  id: 42n, status: "active", dueAt: second("2026-09-07T12:34:56Z"),
  principal: 25_000_001n, interest: 1_250_002n, collateral: 2_500_000_000_000_000_001n,
};
const input = { market, loan, url: "https://turret.capital/p2p?market=0xabc&loan=42", now: second("2026-09-01T01:02:03Z") };
const unfold = (content: string) => content.replace(/\r\n[ \t]/g, "");
const uids = (content: string) => unfold(content).split("\r\n").filter(line => line.startsWith("UID:"));

describe("loan calendar download", () => {
  it("exports exact UTC due and final deadline events with two final-deadline alarms", () => {
    const result = loanCalendar(input)!;
    const content = unfold(result.content);
    const events = content.split("BEGIN:VEVENT\r\n").slice(1);
    expect(events).toHaveLength(2);
    expect(events[0]).toContain("DTSTART:20260907T123456Z\r\n");
    expect(events[0]).not.toContain("BEGIN:VALARM");
    expect(events[1]).toContain("DTSTART:20260908T123456Z\r\n");
    expect(events[1]!.match(/BEGIN:VALARM/g)).toHaveLength(2);
    expect(events[1]).toContain("TRIGGER;RELATED=START:-P1D\r\n");
    expect(events[1]).toContain("TRIGGER;RELATED=START:-PT1H\r\n");
    expect(events[1]!.match(/ACTION:DISPLAY/g)).toHaveLength(2);
    expect(content.match(/DTSTAMP:20260901T010203Z/g)).toHaveLength(2);
    expect(content).toContain("VERSION:2.0\r\n");
    expect(content).not.toContain("TZID");
    expect(result.filename).toBe(`turret-loan-${market.chainId}-${market.address}-42.ics`);
  });

  it("includes exact fixed amounts, collateral risk, outage warning and loan URL", () => {
    const content = unfold(loanCalendar(input)!.content);
    expect(content).toContain("Fixed repayment: 26.250003 USDG (principal 25.000001 + fixed interest 1.250002 USDG).");
    expect(content).toContain("Collateral at risk: 2.500000000000000001 AAPL.");
    expect(content).toContain("After that deadline\\, all collateral may be assigned to the lender.");
    expect(content).toContain("Network\\, wallet or website outages do not extend the on-chain deadline.");
    expect(content).toContain("does not update automatically after repayment or settlement.");
    expect(content.match(new RegExp(`URL:${input.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r\\n`, "g"))).toHaveLength(2);
  });

  it("adds exactly 86400 seconds across a daylight-saving boundary", () => {
    const content = unfold(loanCalendar({ ...input, loan: { ...loan, dueAt: second("2026-03-28T12:34:56Z") } })!.content);
    expect(content).toContain("DTSTART:20260328T123456Z\r\n");
    expect(content).toContain("DTSTART:20260329T123456Z\r\n");
  });

  it.each([0, 86_400, 86_401])("preserves actual deadlines when downloaded %i seconds after due", offset => {
    const content = unfold(loanCalendar({ ...input, now: loan.dueAt + offset })!.content);
    expect(content).toContain("DTSTART:20260907T123456Z\r\n");
    expect(content).toContain("DTSTART:20260908T123456Z\r\n");
  });

  it.each(["open", "repaid", "claimed", "cancelled", "expired", "unknown"])("does not export %s loans", status => {
    expect(loanCalendar({ ...input, loan: { ...loan, status } })).toBeNull();
  });

  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER, 253_402_214_400])("rejects invalid or unrepresentable due timestamp %s", dueAt => {
    expect(loanCalendar({ ...input, loan: { ...loan, dueAt } })).toBeNull();
  });

  it.each([-1, NaN, Infinity, 1.5, 253_402_300_800])("rejects invalid generated-at timestamp %s", now => {
    expect(loanCalendar({ ...input, now })).toBeNull();
  });

  it("supports the final four-digit UTC year and Unix epoch creation time", () => {
    const content = unfold(loanCalendar({ ...input, loan: { ...loan, dueAt: 253_402_214_399 }, now: 0 })!.content);
    expect(content).toContain("DTSTART:99991230T235959Z\r\n");
    expect(content).toContain("DTSTART:99991231T235959Z\r\n");
    expect(content).toContain("DTSTAMP:19700101T000000Z\r\n");
  });

  it("defaults the creation timestamp to the current second", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-01T01:02:03.999Z"));
      expect(unfold(loanCalendar({ ...input, now: undefined })!.content)).toContain("DTSTAMP:20260901T010203Z\r\n");
    } finally { vi.useRealTimers(); }
  });

  it("binds stable UIDs to chain, canonical escrow address, loan ID and event type", () => {
    const original = uids(loanCalendar(input)!.content);
    expect(new Set(original).size).toBe(2);
    expect(original[0]).toContain(`${market.chainId}-${market.address}-42-due@`);
    expect(original[1]).toContain(`${market.chainId}-${market.address}-42-deadline@`);
    expect(uids(loanCalendar({ ...input, now: input.now + 1, url: "https://example.com/", market: { ...market, address: `0x${market.address.slice(2).toUpperCase()}` } })!.content)).toEqual(original);
    for (const changes of [
      { market: { ...market, chainId: 31337 } },
      { market: { ...market, address: `0x${"1".repeat(40)}` } },
      { loan: { ...loan, id: 43n } },
    ]) {
      expect(uids(loanCalendar({ ...input, ...changes })!.content).every(uid => !original.includes(uid))).toBe(true);
    }
  });

  it("escapes delimiters, backslashes and injected text lines without creating calendar components", () => {
    const symbol = "AAPL, Inc; \\\r\nBEGIN:VEVENT\nSUMMARY:injected\rEND:VCALENDAR\u0000";
    const content = unfold(loanCalendar({ ...input, market: { ...market, collateralSymbol: symbol } })!.content);
    expect(content.split("\r\n").filter(line => line === "BEGIN:VEVENT")).toHaveLength(2);
    expect(content.split("\r\n").filter(line => line === "END:VCALENDAR")).toHaveLength(1);
    expect(content).toContain("AAPL\\, Inc\\; \\\\\\nBEGIN:VEVENT\\nSUMMARY:injected\\nEND:VCALENDAR");
    expect(content).not.toContain("\u0000");
    expect(content).not.toContain("\r\nSUMMARY:injected");
  });

  it("folds UTF-8 lines at 75 octets without splitting Unicode characters, including continuation spaces", () => {
    const symbol = "銘柄é📆".repeat(30);
    const result = loanCalendar({ ...input, market: { ...market, collateralSymbol: symbol } })!;
    const encoded = new TextEncoder().encode(result.content);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(encoded)).toBe(result.content);
    expect(result.content).toContain("\r\n ");
    for (const line of result.content.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(result.content.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(result.content.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(unfold(result.content)).toContain(`SUMMARY:Turret ${symbol} loan #42: due\r\n`);
  });

  it.each([
    "javascript:alert(1)", "data:text/calendar,BEGIN:VCALENDAR", "file:///tmp/loan", "/p2p", "//example.com/p2p",
    "https://example.com/\r\nBEGIN:VEVENT", "https://example.com/\nSUMMARY:injected", "https://exa\tmple.com/",
    " https://example.com/", "https://example.com/path with space", "https://example.com/\u007f",
  ])("rejects unsafe URL %j", url => {
    expect(loanCalendar({ ...input, url })).toBeNull();
  });

  it("accepts serialized HTTP(S) URIs and does not apply TEXT escaping to their URL properties", () => {
    for (const url of ["http://localhost:3000/p2p", "https://example.com/p2p?a=b,c;d&line=%0D%0ABEGIN%3AVEVENT", "https://example.com/銘柄"]) {
      const content = unfold(loanCalendar({ ...input, url })!.content);
      expect(content).toContain(`URL:${new URL(url).href}\r\n`);
      expect(content.split("\r\n").filter(line => line === "BEGIN:VEVENT")).toHaveLength(2);
    }
  });

  it("formats large integer amounts and zero-decimal collateral without rounding", () => {
    const principal = 123456789012345678901234567890123456789n;
    const content = unfold(loanCalendar({ ...input, market: { ...market, collateralDecimals: 0 }, loan: { ...loan, principal, interest: 0n, collateral: 3n } })!.content);
    expect(content).toContain("Fixed repayment: 123456789012345678901234567890123.456789 USDG");
    expect(content).toContain("Collateral at risk: 3 AAPL.");
  });

  it("rejects malformed identities and monetary metadata instead of generating misleading reminders", () => {
    for (const changes of [
      { market: { ...market, address: "0x123\r\nBEGIN:VEVENT" } },
      { market: { ...market, address: `0x${"0".repeat(40)}` } },
      { market: { ...market, chainId: 1.5 } },
      { market: { ...market, loanDecimals: -1 } },
      { market: { ...market, collateralDecimals: 37 } },
      { loan: { ...loan, id: 0n } },
      { loan: { ...loan, principal: 0n } },
      { loan: { ...loan, interest: -1n } },
      { loan: { ...loan, collateral: 0n } },
      { loan: { ...loan, principal: (1n << 256n) - 1n, interest: 1n } },
    ]) expect(loanCalendar({ ...input, ...changes })).toBeNull();
  });
});

it("uses a mutually extended final deadline without changing the original due event", () => {
  const result = loanCalendar({ ...input, loan: { ...loan, repaymentDeadline: second("2026-09-20T15:45:00Z") } })!;
  const content = unfold(result.content);
  expect(content).toContain("DTSTART:20260907T123456Z\r\n");
  expect(content).toContain("DTSTART:20260920T154500Z\r\n");
  expect(content).not.toContain("DTSTART:20260908T123456Z\r\n");
  expect(content).toContain("extended by mutual agreement");
  expect(content).toContain("Download a new reminder after agreeing an extension");
});
it.each([0, -1, NaN, Infinity, loan.dueAt + 1, 253_402_300_800])("rejects invalid V3 repayment deadline %s", repaymentDeadline => {
  expect(loanCalendar({ ...input, loan: { ...loan, repaymentDeadline } })).toBeNull();
});
