import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const ART = [
  '................................',
  '...........kkkkkkkkkk...........',
  '........kkkbbbbbbbbbbkkk........',
  '......kkbbbbggggbbbbbbbbkk......',
  '.....kbbbbbggggggbbbbbbbbbk.....',
  '....kbbbbbgggggggbbbrrrbbbbk....',
  '...kbbbbbbggggggbbbrrrrrbbbbk...',
  '..kbbbbbbbbgggggbbrrrrrrbbbbbk..',
  '..kbbbgbbbbbgggbbbbrrrrbbbbbbk..',
  '.kbbbggggbbbbgbbbbbbrrbbbbbbbbk.',
  '.kbbgggggggbbbbbbbbbbbbbbyybbbk.',
  '.kbbggggggggbbbbbbbbbbbbyyyybbk.',
  'kbbbgggggggggbbbbbbbbbbyyyyyybbk',
  'kbbbbgggggggbbbbbbbbbbbbyyyyybbk',
  'kbbbbbggggbbbbbbbggbbbbbbyyybbbk',
  'kbbbbbbgggbbbbbbggggbbbbbbbbbbbk',
  'kbbbbbbbggbbbbbgggggggbbbbbbbbbk',
  'kbbbbbbbbgbbbbbggggggggbbbbbbbbk',
  'kbbbbbbbbbbbbbbbgggggggbbbbbbbbk',
  'kbbbbbbbbbbbbbbbbgggggbbbbbgggbk',
  '.kbbbbbbbbbbbbbbbbggggbbbbgggbk.',
  '.kbbbbbbbbbbbbbbbbbggbbbbbgggbk.',
  '.kbbbbbbbbbbbbbbbbbbbbbbbbbbbbk.',
  '..kbbbbbbbbbbbbbbbbbbbbbbbbbbk..',
  '..kbbbbbbbbbbbbbbbbbbbbbbbbbbk..',
  '...kbbbbbbbbbbbbbbbbbbbbbbbbk...',
  '....kbbbbbbbbbbbbbbbbbbbbbbk....',
  '.....kbbbbbbbbbbbbbbbbbbbbk.....',
  '......kkbbbbbbbbbbbbbbbbkk......',
  '........kkkbbbbbbbbbbkkk........',
  '...........kkkkkkkkkk...........',
  '................................',
];
const PAL = { k: [10, 12, 18, 255], b: [36, 92, 150, 255], g: [92, 170, 80, 255], r: [216, 66, 58, 255], y: [242, 194, 58, 255], '.': [0, 0, 0, 0] };

function pixels(N) {
  const raw = Buffer.alloc((N * 4 + 1) * N);
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0;
    for (let x = 0; x < N; x++) {
      const c = PAL[ART[Math.floor((y * 32) / N)][Math.floor((x * 32) / N)]];
      raw.set(c, y * (N * 4 + 1) + 1 + x * 4);
    }
  }
  return raw;
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
function png(N) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels(N))), chunk('IEND', Buffer.alloc(0))]);
}

function ico(sizes) {
  const images = sizes.map(png);
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((n, i) => {
    const o = 6 + 16 * i;
    head[o] = n >= 256 ? 0 : n; head[o + 1] = n >= 256 ? 0 : n;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(images[i].length, o + 8); head.writeUInt32LE(offset, o + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

const big = png(256);
writeFileSync(new URL('../build/icon.png', import.meta.url), big);
writeFileSync(new URL('../web/icon.png', import.meta.url), big);
writeFileSync(new URL('../build/icon.ico', import.meta.url), ico([16, 32, 48, 64, 128, 256]));
console.log('icons written');
