import { useEffect, useRef, useState } from "react";
import type { EIP1193Provider } from "viem";
import { defaultWalletAvatar, WALLET_AVATAR_PALETTES, type WalletAvatar as WalletAvatarConfig } from "../../../../shared/wallet-avatar.mjs";
import { cachedProfile, loadProfile, prepareProfilePhoto, saveProfile, type WalletProfile } from "./client";
import { WalletAvatar } from "./WalletAvatar";
import "./profiles.css";

export function WalletProfileEditor({ address, provider, chainId }: { address: string; provider: EIP1193Provider | null; chainId: number | null }) {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<WalletProfile | null>(null);
  const [draft, setDraft] = useState<WalletAvatarConfig>(() => defaultWalletAvatar(address));
  const [photo, setPhoto] = useState<{ image: string; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const session = useRef(0);
  useEffect(() => { session.current++; setOpen(false); setBusy(false); setProfile(null); setPhoto(null); setNotice(null); }, [address, provider, chainId]);
  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    if (!open && element?.open) element.close();
  }, [open]);
  useEffect(() => () => { session.current++; }, []);
  async function edit() {
    const token = ++session.current;
    setNotice(null); setError(null); setPhoto(null); setProfile(null);
    setDraft(cachedProfile(address)?.avatar ?? defaultWalletAvatar(address)); setOpen(true);
    try { const current = await loadProfile(address, true); if (session.current === token) { setProfile(current); setDraft(current.avatar); } }
    catch (cause) { if (session.current === token) setError(cause instanceof Error ? cause.message : "Unable to load your profile. Try again."); }
  }
  function close() { if (!busy) { session.current++; setOpen(false); setPhoto(null); } }
  async function upload(file?: File) {
    if (!file) return;
    const token = session.current; setBusy(true); setError(null);
    try { const value = await prepareProfilePhoto(file); if (session.current === token) { setDraft(value.avatar); setPhoto(value); } }
    catch (cause) { if (session.current === token) setError(cause instanceof Error ? cause.message : "Unable to use this photo."); }
    finally { if (session.current === token) setBusy(false); }
  }
  async function save() {
    if (!profile || !provider || chainId !== 4663 || busy) return;
    const token = session.current; setBusy(true); setError(null);
    try {
      await saveProfile({ profile, avatar: draft, image: photo?.image, provider, isCurrent: () => session.current === token });
      if (session.current === token) { setOpen(false); setPhoto(null); setNotice("Profile picture saved."); }
    } catch (cause) {
      if (session.current === token) setError((cause as { code?: number })?.code === 4001 || /rejected|denied/i.test(String(cause))
        ? "Signature declined. Your profile picture has not changed."
        : cause instanceof Error ? cause.message : "Unable to save your picture. Try again.");
    } finally { if (session.current === token) setBusy(false); }
  }
  return <div className="wallet-profile">
    <button className="wallet-profile-trigger" onClick={() => void edit()} aria-label="Change profile picture">
      <WalletAvatar address={address} size={48} /><span>Change picture</span>
    </button>
    {notice && <span className="wallet-profile-notice" role="status">{notice}</span>}
    <dialog className="wallet-profile-dialog" ref={dialog} aria-labelledby="profile-title" onCancel={event => { event.preventDefault(); close(); }}>
      <div className="wallet-profile-dialog-heading"><h2 id="profile-title">Your profile picture</h2>
        <button className="wallet-profile-close" aria-label="Close profile editor" disabled={busy} onClick={close}>×</button></div>
      <p>Public on your P2P offers and loans. Your wallet address still identifies you.</p>
      <div className="wallet-profile-preview"><WalletAvatar address={address} size={112} avatar={draft} preview={photo?.preview} /></div>
      <fieldset disabled={busy || !profile} className="wallet-profile-options">
        <legend>Make it yours</legend>
        <div className="wallet-profile-palettes" aria-label="Picture colors">{WALLET_AVATAR_PALETTES.map((colors, index) =>
          <button key={index} aria-label={`${["Stone", "Blue", "Green", "Amber", "Rose", "Violet", "Teal", "Orange"][index]} picture`}
            aria-pressed={draft.kind === "generated" && draft.palette === index} style={{ color: colors[1] }}
            onClick={() => { setPhoto(null); setDraft({ ...(draft.kind === "generated" ? draft : defaultWalletAvatar(address)), palette: index }); }} />)}</div>
        <div className="wallet-profile-choices"><button onClick={() => {
          const seed = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
          setPhoto(null); setDraft({ kind: "generated", version: 1, seed, palette: draft.kind === "generated" ? draft.palette : 0 });
        }}>Generate another</button>
          <label className="wallet-profile-upload">Upload photo<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} /></label>
        </div>
        <p className="wallet-profile-small">PNG, JPEG or WebP, up to 10 MB. Photos are cropped to a square.</p>
      </fieldset>
      {!profile && !error && <p role="status">Loading your saved picture…</p>}
      {error && <p className="wallet-profile-error" role="alert">{error} {!profile && <button onClick={() => void edit()}>Retry</button>}</p>}
      {chainId !== 4663 && <p className="wallet-profile-error">Switch your wallet to Robinhood Chain to save.</p>}
      <p className="wallet-profile-small">Saving asks for a wallet signature. No transaction fee.</p>
      <button className="wallet-profile-save" disabled={busy || !profile || !provider || chainId !== 4663} onClick={() => void save()}>{busy ? "Confirming your picture…" : "Sign and save picture"}</button>
    </dialog>
  </div>;
}
