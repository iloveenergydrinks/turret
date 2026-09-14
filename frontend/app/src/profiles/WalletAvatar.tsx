import { useEffect, useState } from "react";
import { defaultWalletAvatar, normalizeWalletAddress, renderWalletAvatar, type WalletAvatar as WalletAvatarConfig } from "../../../../shared/wallet-avatar.mjs";
import { cachedProfile, loadProfile, subscribeProfiles } from "./client";
import "./profiles.css";

export function avatarUrl(avatar: WalletAvatarConfig) {
  return avatar.kind === "image" ? `/api/profiles/avatar/${avatar.hash}.png` : `data:image/svg+xml,${encodeURIComponent(renderWalletAvatar(avatar))}`;
}
export function WalletAvatar({ address, size = 40, avatar, preview, label = "" }: {
  address: string; size?: number; avatar?: WalletAvatarConfig; preview?: string; label?: string;
}) {
  const key = normalizeWalletAddress(address);
  const [, update] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (avatar) return;
    const unsubscribe = subscribeProfiles(() => update(value => value + 1));
    void loadProfile(key).catch(() => {});
    return unsubscribe;
  }, [key, avatar]);
  const src = preview || avatarUrl(avatar ?? cachedProfile(key)?.avatar ?? defaultWalletAvatar(key));
  return <img className="wallet-avatar" src={failed === src ? avatarUrl(defaultWalletAvatar(key)) : src}
    width={size} height={size} alt={label} onError={() => setFailed(src)} />;
}
