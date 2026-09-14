import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import CrcCalculator from 'pngjs/lib/crc.js';
import { ProfileError } from './store.mjs';

export const MAX_IMAGE_BYTES = 300 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ancillaryLengths = { sRGB: 1, gAMA: 4, cHRM: 32, pHYs: 9 };

/** Accept only the small, static PNG subset produced by our browser canvas. */
export function validateProfileImage(base64, expectedHash) {
  try {
    if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
      || base64.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error();
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length < 57 || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== base64
      || !bytes.subarray(0, 8).equals(signature)
      || createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error();
    let position = 8, chunks = 0, header = false, ended = false, dataStarted = false, dataEnded = false, colorType;
    const compressed = [], seen = new Set();
    while (position < bytes.length) {
      if (++chunks > 256 || position + 12 > bytes.length) throw new Error();
      const length = bytes.readUInt32BE(position), type = bytes.toString('ascii', position + 4, position + 8);
      if (position + 12 + length > bytes.length || !/^[A-Za-z]{4}$/.test(type)) throw new Error();
      const data = bytes.subarray(position + 8, position + 8 + length);
      if ((CrcCalculator.crc32(bytes.subarray(position + 4, position + 8 + length)) >>> 0)
        !== bytes.readUInt32BE(position + 8 + length)) throw new Error();
      if (!header && type !== 'IHDR') throw new Error();
      if (type === 'IHDR') {
        if (header || length !== 13 || data.readUInt32BE(0) !== 256 || data.readUInt32BE(4) !== 256
          || data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) throw new Error();
        header = true; colorType = data[9];
      } else if (type === 'IDAT') {
        if (dataEnded || ended) throw new Error();
        dataStarted = true; compressed.push(data);
      } else if (type === 'IEND') {
        if (length || !dataStarted || position + 12 !== bytes.length) throw new Error();
        ended = true;
      } else {
        if (!(type in ancillaryLengths) || length !== ancillaryLengths[type] || seen.has(type) || dataStarted) throw new Error();
        if (type === 'sRGB' && data[0] > 3) throw new Error();
        if (type === 'gAMA' && !data.readUInt32BE(0)) throw new Error();
        if (type === 'pHYs' && data[8] > 1) throw new Error();
        seen.add(type);
      }
      if (dataStarted && type !== 'IDAT') dataEnded = true;
      position += length + 12;
    }
    if (!ended) throw new Error();
    const packed = Buffer.concat(compressed);
    const expectedSize = (256 * (colorType === 6 ? 4 : 3) + 1) * 256;
    // pngjs truncates an overlong non-interlaced inflate stream. Check exact
    // bounded decompression and compressed input consumption before its decoder.
    const inflated = inflateSync(packed, { maxOutputLength: expectedSize + 1, info: true });
    if (inflated.buffer.length !== expectedSize || inflated.engine.bytesWritten !== packed.length) throw new Error();
    const image = PNG.sync.read(bytes, { checkCRC: true });
    if (image.width !== 256 || image.height !== 256 || image.data.length !== 256 * 256 * 4) throw new Error();
    return bytes;
  } catch { throw new ProfileError('Use a valid 256×256 PNG avatar no larger than 300 KB.'); }
}
