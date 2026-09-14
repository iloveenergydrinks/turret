"use client";
import { useState } from "react";

const text = (value: bigint) => {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toLocaleString("en-US")}.${fraction}`;
};

/** Roll only between verified balances. Never extrapolate claimable money. */
export function RewardCounter({ value }: { value: bigint }) {
  const [frame, setFrame] = useState({ value, previous: value });
  if (frame.value !== value) setFrame({ value, previous: frame.value });
  const current = text(value);
  const previous = text(frame.previous).padStart(current.length, " ");
  // Claims and corrections must immediately show the lower balance.
  const increasing = value > frame.previous;
  return <span className="turret-reward-counter">
    <span className="turret-reward-accessible">{current}</span>
    <span aria-hidden="true">{[...current].map((digit, index) => {
      const old = previous[index];
      const roll = increasing && /\d/.test(digit) && /\d/.test(old ?? "") && digit !== old;
      return <span className="turret-reward-digit" key={current.length - index}>
        <span key={`${digit}:${roll}`} className={roll ? "turret-reward-digit-in" : undefined}>{digit}</span>
        {roll && <span key={`old:${old}:${digit}`} className="turret-reward-digit-out" data-digit={old} />}
      </span>;
    })}</span>
  </span>;
}
