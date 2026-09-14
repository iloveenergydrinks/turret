/** Public avatar parameters only. Never accepts markup, image URLs, or uploads. */
export const WALLET_AVATAR_PALETTES = Object.freeze([
  ['#f5f5f4', '#292524', '#78716c'], ['#e0f2fe', '#075985', '#38bdf8'],
  ['#dcfce7', '#166534', '#4ade80'], ['#fef3c7', '#92400e', '#fbbf24'],
  ['#ffe4e6', '#9f1239', '#fb7185'], ['#ede9fe', '#5b21b6', '#a78bfa'],
  ['#ccfbf1', '#115e59', '#2dd4bf'], ['#ffedd5', '#9a3412', '#fb923c'],
].map(Object.freeze));

export function normalizeWalletAddress(address) {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Invalid wallet address');
  return address.toLowerCase();
}

export function validateWalletAvatar(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'hash,kind,version'
    && value.kind === 'image' && value.version === 1
    && typeof value.hash === 'string' && /^[0-9a-f]{64}$/.test(value.hash)) {
    return { kind: 'image', version: 1, hash: value.hash };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'kind,palette,seed,version'
    || value.kind !== 'generated' || value.version !== 1
    || typeof value.seed !== 'string' || !/^[0-9a-f]{64}$/.test(value.seed)
    || !Number.isInteger(value.palette) || value.palette < 0 || value.palette >= WALLET_AVATAR_PALETTES.length) {
    throw new Error('Invalid wallet avatar');
  }
  return { kind: 'generated', version: 1, seed: value.seed, palette: value.palette };
}

function seedNumber(seed) {
  let value = 2166136261;
  for (const character of seed) value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
  return value || 1;
}

export function defaultWalletAvatar(address) {
  const seed = normalizeWalletAddress(address).slice(2).padStart(64, '0');
  return { kind: 'generated', version: 1, seed, palette: seedNumber(seed) % WALLET_AVATAR_PALETTES.length };
}

export function renderWalletAvatar(value, { size = 128 } = {}) {
  const avatar = validateWalletAvatar(value);
  if (avatar.kind !== 'generated') throw new Error('Only generated avatars render as SVG');
  if (!Number.isInteger(size) || size < 16 || size > 1024) throw new Error('Invalid avatar size');
  const [background, foreground, accent] = WALLET_AVATAR_PALETTES[avatar.palette];
  let state = seedNumber(avatar.seed);
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const shapes = [];
  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 3; column++) {
      const bits = next();
      if ((bits & 3) === 0) continue;
      const fill = (bits & 4) ? foreground : accent;
      for (const x of column === 2 ? [54] : [18 + column * 18, 90 - column * 18]) {
        shapes.push(`<rect x="${x}" y="${18 + row * 18}" width="16" height="16" rx="${(bits & 8) ? 8 : 3}" fill="${fill}"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 124 124" width="${size}" height="${size}"><rect width="124" height="124" rx="28" fill="${background}"/>${shapes.join('')}</svg>`;
}
