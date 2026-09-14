export type GeneratedWalletAvatar = { kind: 'generated'; version: 1; seed: string; palette: number };
export type ImageWalletAvatar = { kind: 'image'; version: 1; hash: string };
export type WalletAvatar = GeneratedWalletAvatar | ImageWalletAvatar;
export type WalletAvatarConfig = WalletAvatar;
export const WALLET_AVATAR_PALETTES: ReadonlyArray<readonly [string, string, string]>;
export function normalizeWalletAddress(address: string): `0x${string}`;
export function validateWalletAvatar(value: unknown): WalletAvatar;
export function defaultWalletAvatar(address: string): GeneratedWalletAvatar;
export function renderWalletAvatar(value: GeneratedWalletAvatar, options?: { size?: number }): string;
