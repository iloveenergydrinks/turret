"use client";
import { usePathname } from "next/navigation";
import { StakingPage } from "@/src/staking/StakingPage";
export default function Layout() { return <StakingPage legacy={usePathname() === "/stake/legacy"} />; }
