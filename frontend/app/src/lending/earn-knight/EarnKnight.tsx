"use client";
import { useEffect, useRef } from "react";
import { mountEarnHero } from "./host";

export function EarnKnight() {
  const host = useRef<HTMLElement>(null);
  useEffect(() => mountEarnHero(host.current!), []);
  return <figure ref={host} className="turret-earn-knight" data-earn-knight="loading" />;
}
