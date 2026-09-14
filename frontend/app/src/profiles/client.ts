import { createWalletClient, custom, type Address, type EIP1193Provider } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { defaultWalletAvatar, normalizeWalletAddress, validateWalletAvatar, type WalletAvatar as WalletAvatarConfig } from "../../../../shared/wallet-avatar.mjs";

export type WalletProfile = { address: string; avatar: WalletAvatarConfig; revision: number; updatedAt: number | null };
type Entry = { value: WalletProfile; expires: number };
const profiles = new Map<string, Entry>();
const requests = new Map<string, Promise<WalletProfile>>();
const listeners = new Set<() => void>();
const MAX_PROFILES = 512;
export const subscribeProfiles = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const defaultProfile = (address: string): WalletProfile => ({ address: normalizeWalletAddress(address), avatar: defaultWalletAvatar(address), revision: 0, updatedAt: null });
export const cachedProfile = (address: string) => profiles.get(normalizeWalletAddress(address))?.value;

function validateProfile(value: unknown, address: string): WalletProfile {
  const item = value as WalletProfile;
  if (!item || item.address !== normalizeWalletAddress(address) || !Number.isSafeInteger(item.revision) || item.revision < 0
    || !(item.updatedAt === null || (Number.isSafeInteger(item.updatedAt) && item.updatedAt > 0))) throw new Error("Invalid profile response.");
  return { address: item.address, avatar: validateWalletAvatar(item.avatar), revision: item.revision, updatedAt: item.updatedAt };
}
function remember(profile: WalletProfile) {
  const previous = profiles.get(profile.address);
  if (previous && previous.value.revision > profile.revision) return previous.value;
  profiles.delete(profile.address);
  profiles.set(profile.address, { value: profile, expires: Date.now() + 60_000 });
  while (profiles.size > MAX_PROFILES) profiles.delete(profiles.keys().next().value!);
  listeners.forEach(listener => listener());
  return profile;
}
async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`/api/profiles/${path}`, { method: body ? "POST" : "GET", credentials: "same-origin",
    cache: "no-store", signal: AbortSignal.timeout(15_000), ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof value?.error === "string" && value.error.length <= 200 ? value.error : "Profile pictures are temporarily unavailable. Try again.");
  return value;
}
export async function loadProfile(address: string, fresh = false): Promise<WalletProfile> {
  const key = normalizeWalletAddress(address), existing = profiles.get(key);
  if (!fresh && existing && existing.expires > Date.now()) return existing.value;
  const pending = requests.get(key);
  if (pending) return pending;
  const request = api(key).then(value => remember(validateProfile(value, key))).finally(() => requests.delete(key));
  requests.set(key, request);
  return request;
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function assertProfileChallenge(challenge: { nonce: string; message: string }, profile: WalletProfile, avatar: WalletAvatarConfig, origin = window.location.origin) {
  if (!challenge || !/^[a-f0-9]{64}$/.test(challenge.nonce) || typeof challenge.message !== "string" || challenge.message.length > 4096) throw new Error("Invalid avatar signing request.");
  const parsed = parseSiweMessage(challenge.message), url = new URL(origin), now = Date.now();
  const hash = await sha256(new TextEncoder().encode(JSON.stringify(validateWalletAvatar(avatar))));
  if (parsed.address?.toLowerCase() !== profile.address || parsed.domain !== url.host || parsed.scheme !== url.protocol.slice(0, -1)
    || parsed.uri !== `${origin}/api/profiles/${profile.address}` || parsed.chainId !== 4663 || parsed.version !== "1"
    || parsed.nonce !== challenge.nonce || parsed.requestId !== `avatar-update-${profile.revision}`
    || parsed.statement !== "Save this public Turret wallet avatar. This signature authorizes no token approvals or blockchain transactions."
    || !parsed.issuedAt || !parsed.expirationTime || parsed.issuedAt.getTime() > now + 30_000 || parsed.issuedAt.getTime() < now - 300_000
    || parsed.expirationTime.getTime() <= now || parsed.expirationTime.getTime() > now + 330_000
    || JSON.stringify(parsed.resources) !== JSON.stringify([`urn:turret:avatar:sha256:${hash}`, `urn:turret:avatar:revision:${profile.revision}`])) {
    throw new Error("The signing request does not match this avatar update.");
  }
}
export async function saveProfile({ profile, avatar, image, provider, isCurrent = () => true }: {
  profile: WalletProfile; avatar: WalletAvatarConfig; image?: string; provider: EIP1193Provider; isCurrent?: () => boolean;
}): Promise<WalletProfile> {
  const account = profile.address as Address;
  const checkWallet = async () => {
    const [accounts, chain] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]);
    if (!isCurrent() || accounts[0]?.toLowerCase() !== account || Number(chain) !== 4663) throw new Error("Your wallet changed. Reopen the profile editor to continue.");
  };
  await checkWallet();
  const selected = validateWalletAvatar(avatar);
  const challenge = await api("challenge", { address: account, avatar: selected, expectedRevision: profile.revision, ...(image ? { image } : {}) }) as { nonce: string; message: string };
  await assertProfileChallenge(challenge, profile, selected);
  await checkWallet();
  const signature = await createWalletClient({ transport: custom(provider) }).signMessage({ account, message: challenge.message });
  await checkWallet();
  const updated = validateProfile(await api("save", { nonce: challenge.nonce, signature }), account);
  if (updated.revision !== profile.revision + 1 || JSON.stringify(updated.avatar) !== JSON.stringify(selected)) throw new Error("The saved profile did not match your update. Reload to check it.");
  return remember(updated);
}

export async function prepareProfilePhoto(file: File): Promise<{ avatar: WalletAvatarConfig; image: string; preview: string }> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024 || file.size === 0) throw new Error("Choose a PNG, JPEG or WebP photo under 10 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error("Choose a photo smaller than 40 megapixels.");
    const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot prepare photos. Choose a generated picture instead.");
    const size = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 256, 256);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Unable to prepare this photo.")), "image/png"));
    if (blob.size > 300 * 1024) throw new Error("This photo is too large after resizing. Try a different one.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const image = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
    return { avatar: { kind: "image", version: 1, hash: await sha256(bytes) }, image, preview: `data:image/png;base64,${image}` };
  } finally { bitmap.close(); }
}
