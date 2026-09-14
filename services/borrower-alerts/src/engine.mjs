import { createHash, randomBytes } from "node:crypto";
export const token = () => randomBytes(32).toString("hex");
export const hash = (text) => createHash("sha256").update(text).digest("hex");
export class InputError extends Error {}
const demand = (condition, message) => {
  if (!condition) throw new InputError(message);
};
const riskSeverity={warning:1,critical:2,eligible:3};
// Explicit delivery allowlist also covers messages queued by older releases.
const deliverable=job=>job.kind==='liquidation-risk'&&Boolean(riskSeverity[job.riskStatus])
  ||Boolean(job.pending&&job.id?.startsWith('verify:'));

export class Engine {
  constructor({ store, origin, vault, verify, send, now = Date.now, positionUrl, verificationUrl, protocol = 'stock', chainId = 4663, scope }) {
    Object.assign(this, { store, origin, vault, verify, send, now, protocol, chainId, scope });
    this.positionUrl = positionUrl ?? `${origin}/borrow`;
    this.verificationUrl = verificationUrl ?? `${origin}/alerts/verify`;
  }
  get isP2P() { return this.protocol === 'p2p' || this.protocol === 'nft'; }
  get alertBrand() { return this.protocol === 'nft' ? 'Turret NFT P2P' : this.protocol === 'p2p' ? 'Turret P2P' : 'Turret'; }
  rate(key, limit, duration) {
    const id = hash(key), old = this.store.get("rate", id);
    const row = old && old.until > this.now() ? old : { count: 0, until: this.now() + duration };
    demand(row.count < limit, "Too many requests. Try again later.");
    row.count++;
    this.store.put("rate", id, row);
  }
  challenge(wallet) {
    demand(/^0x[0-9a-f]{40}$/i.test(wallet ?? ""), "Invalid wallet");
    wallet = wallet.toLowerCase();
    this.rate(`challenge:${wallet}`, 10, 3600000);
    const id = token(), until = this.now() + 300000;
    const message =
      `${this.origin} requests ${this.isP2P ? this.alertBrand : 'Dockyard borrower'} alert access.\nWallet: ${wallet}\nChain ID: ${this.chainId}\n${this.isP2P ? `Market scope: ${this.scope}` : `Vault: ${this.vault}`}\nNonce: ${id}\nExpires: ${
        new Date(until).toISOString()
      }\nThis signature only manages notifications. It authorizes no token approvals or transactions.`;
    this.store.put("challenge", hash(id), { wallet, message, until });
    return { id, message };
  }
  async login(id, signature) {
    demand(
      typeof id === "string" && typeof signature === "string" && signature.length <= 8192,
      "Invalid signature request",
    );
    const row = this.store.get("challenge", hash(id));
    this.store.delete("challenge", hash(id)); // consume before asynchronous verification
    demand(row && row.until > this.now(), "Signature request expired or already used");
    demand(await this.verify(row.wallet, row.message, signature), "Wallet signature does not match");
    const session = token();
    this.store.put("session", hash(session), { wallet: row.wallet, until: this.now() + 1800000 });
    return { session };
  }
  authenticate(session) {
    demand(typeof session === "string", "Verify your wallet first");
    const row = this.store.get("session", hash(session));
    demand(row && row.until > this.now(), "Verify your wallet again");
    return row.wallet;
  }
  subscribe(wallet, channel, email) {
    demand(channel === "email" || channel === "telegram", "Unsupported channel");
    this.rate(`subscribe:${wallet}`, 5, 3600000);
    if (channel === "email") {
      demand(
        typeof email === "string" && email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email),
        "Enter a valid email address",
      );
      this.rate(`email:${email.toLowerCase()}`, 3, 3600000);
    }
    const verification = token(), id = hash(verification);
    // A new request invalidates previous pending links for this wallet/channel.
    for (const pending of this.store.all("pending")) {
      if (pending.wallet === wallet && pending.channel === channel) this.store.delete("pending", pending.id);
    }
    const row = { wallet, channel, contact: channel === "email" ? email : null, until: this.now() + 900000 };
    this.store.put("pending", id, row);
    if (channel === "email") {
      this.enqueue(`verify:${id}`, {
        ...row,
        pending: id,
        text:
          `Confirm ${this.alertBrand} alerts for wallet ${wallet}:\n${this.verificationUrl}#${verification}\nThis link expires in 15 minutes. Ignore it if you did not request alerts.`,
      });
    }
    return verification;
  }
  activate(verification, channel, chat, startBlock) {
    demand(typeof verification === "string", "Invalid verification link");
    demand(startBlock === undefined || ((typeof startBlock === "string" || typeof startBlock === "bigint")
      && /^(0|[1-9][0-9]*)$/.test(String(startBlock))), "Invalid consent block");
    const id = hash(verification), row = this.store.get("pending", id);
    demand(row && row.channel === channel && row.until > this.now(), "Verification link expired or already used");
    demand(
      channel !== "telegram" || (typeof chat === "string" && /^\d+$/.test(chat)),
      "Private Telegram chat required",
    );
    const subId = `${row.wallet}:${channel}`;
    this.remove(row.wallet, channel);
    this.store.put("subscription", subId, {
      wallet: row.wallet,
      channel,
      contact: chat ?? row.contact,
      created: this.now(),
      ...(startBlock === undefined ? {} : { startBlock: String(startBlock) }),
      delivered: null,
      failed: false,
      ...(this.isP2P ? { scope: this.scope, consentId: id } : {}),
    });
    return { verified: true };
  }
  remove(wallet, channel) {
    const subId = `${wallet}:${channel}`;
    this.store.delete("subscription", subId);
    for (const row of this.store.all("pending")) {
      if (row.wallet === wallet && row.channel === channel) this.store.delete("pending", row.id);
    }
    for (const row of this.store.all("outbox")) {
      if (row.subId === subId || (row.wallet === wallet && row.channel === channel)) {
        this.store.delete("outbox", row.id);
      }
    }
    if (!this.store.all("subscription").some((s) => s.wallet === wallet)) {
      for (const row of this.store.all("p2p-discovery")) if (row.wallet === wallet) this.store.delete("p2p-discovery", row.id);
      for (const row of this.store.all("risk")) if (row.wallet === wallet) this.store.delete("risk", row.id);
      for (const row of this.store.all("transaction")) {
        if (row.wallet === wallet) this.store.delete("transaction", row.id);
      }
    }
  }
  list(wallet) {
    return this.store.all("subscription").filter((s) => s.wallet === wallet).map(({ channel, delivered, failed }) => ({
      channel,
      delivered,
      failed,
    }));
  }
  enqueue(id, value) {
    if(!this.deliverable({...value,id}) || this.store.get('p2p-delivery',id))return;
    if (!this.store.get("outbox", id)) {
      this.store.put("outbox", id, {
        ...value,
        attempts: 0,
        next: this.now(),
        until: value.until ?? this.now() + 86400000,
      });
    }
  }
  deliverable(job) {
    return (deliverable(job) && (!this.isP2P || Boolean(job.pending))) || (this.isP2P && job.scope === this.scope
      && ['p2p-event','p2p-deadline','p2p-proposal'].includes(job.kind) && Boolean(job.subId));
  }
  notify(wallet, event, text, riskKey, riskStatus) {
    if(!riskKey||!riskSeverity[riskStatus])return;
    for (const sub of this.store.all("subscription").filter((s) => s.wallet === wallet)) {
      if (riskKey) {
        for (const job of this.store.all("outbox")) {
          if (job.subId === sub.id && job.riskKey === riskKey) this.store.delete("outbox", job.id);
        }
      }
      this.enqueue(`${sub.id}:${event}`, {
        subId: sub.id,
        text,
        riskKey,
        kind:'liquidation-risk',riskStatus,
        until: this.now() + (riskKey ? 3600000 : 86400000),
      });
    }
  }
  risk(wallet, market, health) {
    if (!this.store.all("subscription").some((s) => s.wallet === wallet)) return;
    const id = `${wallet}:${market}`, previous = this.store.get("risk", id), status = health.status;
    // Unknown/healthy/closed states cancel obsolete warnings but never email.
    // Keep notification history across those states to avoid threshold flapping.
    if(!riskSeverity[status]){
      for(const job of this.store.all('outbox'))if(job.riskKey===id)this.store.delete('outbox',job.id);
      this.store.put('risk',id,status==='no-debt'?{wallet,status}:{...previous,wallet,status});return;
    }
    const pending=this.store.all('outbox').filter(job=>job.riskKey===id);
    if(previous?.status!==status)for(const job of pending)if(job.riskStatus!==status)this.store.delete('outbox',job.id);
    const alreadyQueued=this.store.all('outbox').some(job=>job.riskKey===id&&job.riskStatus===status);
    this.store.put('risk',id,{...previous,wallet,status});
    if (!alreadyQueued&&(!previous?.notifiedStatus || riskSeverity[status]>riskSeverity[previous.notifiedStatus]
      || this.now()-(previous.sent??0)>=3600000)) {
        const description = {
          eligible: "Your position is liquidation-eligible. Act immediately; a liquidation may already be in flight.",
          critical: "Your position is critically close to liquidation.",
          warning: "Your position is approaching liquidation.",
        }[status];
        const detail = health.bufferBps == null
          ? ""
          : ` Remaining oracle-price decline to threshold: ${(Number(health.bufferBps) / 100).toFixed(2)}%.`;
        this.notify(
          wallet,
          `risk:${id}:${this.now()}`,
          `Turret: ${description}${detail}\nWallet: ${wallet}\nVault: ${this.vault}\nCollateral: ${market}\nAdd collateral or repay USDG: ${this.positionUrl}\nAlerts are best-effort, not liquidation protection.`,
          id,
          status,
        );
    }
  }
  async deliver() {
    for (const job of this.store.all("outbox")) {
      const sub = job.subId ? this.store.get("subscription", job.subId) : null;
      if (!this.deliverable(job) || (job.kind==='liquidation-risk'&&!riskSeverity[this.store.get('risk',job.riskKey)?.status])
        || job.until <= this.now() || (job.subId && !sub) || (job.pending && !this.store.get("pending", job.pending))) {
        this.store.delete("outbox", job.id);
        continue;
      }
      if (job.next > this.now() || job.attempts >= 10) continue;
      if (job.kind?.startsWith('p2p-')) {
        // A scan failure or an unknown current deadline holds delivery for retry.
        // Definitively obsolete notices are deleted by the P2P monitor.
        try { if (!this.validateP2PDelivery || !await this.validateP2PDelivery(job)) continue; }
        catch { continue; }
        if (this.store.get('subscription', job.subId)?.consentId !== job.consentId || !this.store.get('outbox',job.id)) continue;
      }
      try {
        await this.send(sub?.channel ?? job.channel, sub?.contact ?? job.contact, job.text, hash(job.id));
        if (job.kind?.startsWith('p2p-')) this.store.put('p2p-delivery',job.id,{sent:this.now()});
        this.store.delete("outbox", job.id);
        if(job.kind==='liquidation-risk'){
          const risk=this.store.get('risk',job.riskKey);
          if(risk)this.store.put('risk',job.riskKey,{...risk,notifiedStatus:job.riskStatus,sent:this.now()});
        }
        // Do not recreate a subscription revoked while delivery was in flight.
        if (sub && this.store.get("subscription", job.subId) && (!job.kind?.startsWith('p2p-') || this.store.get('subscription',job.subId).consentId===job.consentId)) {
          this.store.put("subscription", job.subId, { ...sub, delivered: this.now(), failed: false });
        }
      } catch {
        const attempts = job.attempts + 1;
        if (this.store.get("outbox", job.id)) {
          this.store.put("outbox", job.id, {
            ...job,
            attempts,
            next: this.now() + Math.min(3600000, 15000 * 2 ** attempts),
          });
        }
        if (sub && this.store.get("subscription", job.subId) && (!job.kind?.startsWith('p2p-') || this.store.get('subscription',job.subId).consentId===job.consentId)) {
          this.store.put("subscription", job.subId, { ...sub, failed: true });
        }
      }
    }
  }
  prune() {
    for (const kind of ["challenge", "session", "pending", "rate", "transaction", "event"]) {
      for (const row of this.store.all(kind)) {
        if (row.until <= this.now()) this.store.delete(kind, row.id);
      }
    }
  }
}
