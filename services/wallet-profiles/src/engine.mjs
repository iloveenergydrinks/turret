import { createHash, randomBytes } from 'node:crypto';
import { createSiweMessage } from 'viem/siwe';
import { normalizeWalletAddress, validateWalletAvatar } from '../../../shared/wallet-avatar.mjs';
import { ProfileError } from './store.mjs';
import { validateProfileImage } from './image.mjs';

export const avatarHash = avatar => createHash('sha256').update(JSON.stringify(validateWalletAvatar(avatar))).digest('hex');
export const validRevision = revision => Number.isSafeInteger(revision) && revision >= 0 && revision < 1_000_000_000;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.sort().join(',');

export class ProfileEngine {
  constructor({ store, verify, origin = 'https://turret.capital', now = Date.now }) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password
      || (url.protocol !== 'https:' && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) throw new Error('Invalid profile origin');
    Object.assign(this, { store, verify, origin, now });
    this.inFlight = new Set();
  }
  challenge(input) {
    if (!(exactKeys(input, ['address', 'avatar', 'expectedRevision']) || exactKeys(input, ['address', 'avatar', 'expectedRevision', 'image']))
      || !validRevision(input.expectedRevision)) {
      throw new ProfileError('Invalid avatar update request.');
    }
    let address, avatar;
    try {
      address = normalizeWalletAddress(input.address);
      if (/^0x0{40}$/.test(address)) throw new Error('Zero wallet cannot own a profile');
      avatar = validateWalletAvatar(input.avatar);
    }
    catch { throw new ProfileError('Invalid wallet or avatar.'); }
    let image = null;
    if (avatar.kind === 'image') {
      if ('image' in input) image = validateProfileImage(input.image, avatar.hash);
      else if (!this.store.image(avatar.hash)) throw new ProfileError('Upload the selected avatar image.');
    } else if ('image' in input) throw new ProfileError('Generated avatars do not accept image data.');
    const now = this.now();
    this.store.rate(`challenge:${address}`, 20, 3_600_000, now);
    const nonce = randomBytes(32).toString('hex'), expiresAt = now + 300_000;
    const message = createSiweMessage({
      address, chainId: 4663, domain: new URL(this.origin).host, scheme: new URL(this.origin).protocol.slice(0, -1),
      nonce, version: '1', uri: `${this.origin}/api/profiles/${address}`, issuedAt: new Date(now), expirationTime: new Date(expiresAt),
      statement: 'Save this public Turret wallet avatar. This signature authorizes no token approvals or blockchain transactions.',
      requestId: `avatar-update-${input.expectedRevision}`,
      resources: [`urn:turret:avatar:sha256:${avatarHash(avatar)}`, `urn:turret:avatar:revision:${input.expectedRevision}`],
    });
    this.store.addChallenge({ nonce, address, avatar, revision: input.expectedRevision, message, expiresAt, image });
    return { nonce, message };
  }
  async save(input) {
    if (!exactKeys(input, ['nonce', 'signature']) || typeof input.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(input.nonce)
      || typeof input.signature !== 'string' || !/^0x(?:[a-fA-F0-9]{2})+$/.test(input.signature) || input.signature.length > 8194) {
      throw new ProfileError('Invalid avatar signature request.');
    }
    if (this.inFlight.has(input.nonce)) throw new ProfileError('This avatar save is already being verified.', 409);
    if (this.inFlight.size >= 4) throw new ProfileError('Avatar verification is busy. Try again shortly.', 429);
    const row = this.store.challenge(input.nonce), now = this.now();
    if (!row || row.expiresAt <= now) throw new ProfileError('Avatar signature expired or was already used.', 409);
    this.store.rate(`save:${row.address}`, 30, 3_600_000, now);
    this.inFlight.add(input.nonce);
    try {
      const valid = await this.verify(row.address, row.message, input.signature);
      if (!valid) { this.store.discard(input.nonce); throw new ProfileError('The signature does not match this wallet.', 401); }
      return this.store.commit(input.nonce, this.now());
    } finally { this.inFlight.delete(input.nonce); }
  }
}
