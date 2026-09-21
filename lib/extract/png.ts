/**
 * Minimal 8-bit greyscale PNG encoder.
 *
 * Tesseract takes an encoded image buffer, and pdfjs hands back raw pixels, so
 * something has to bridge the two. A native canvas would do it but drags in a
 * binary dependency that does not survive serverless deployment well — and the
 * PNG spec for this one case is small enough to just write.
 *
 * Greyscale on purpose: it is a third of the bytes of RGB and OCR reads it at
 * least as well.
 */

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** `gray` must be exactly width*height bytes, one per pixel. */
export function encodeGrayPng(width: number, height: number, gray: Uint8Array): Buffer {
  if (gray.length !== width * height) {
    throw new Error(
      `greyscale buffer is ${gray.length} bytes but ${width}x${height} needs ${width * height}`,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type 0 = greyscale
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 means "store as-is",
  // which costs a little size and saves a lot of complexity.
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    Buffer.from(gray.buffer, gray.byteOffset + y * width, width).copy(
      raw,
      y * (width + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
