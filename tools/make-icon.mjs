// Рисует пиксельную иконку игры 256x256 (build/icon.png) без сторонних библиотек.
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

const S = 8, N = 32 * S;
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    const c = PAL[ART[(y / S) | 0][(x / S) | 0]];
    raw.set(c, y * (N * 4 + 1) + 1 + x * 4);
  }
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
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
writeFileSync(new URL('../build/icon.png', import.meta.url), png);
writeFileSync(new URL('../web/icon.png', import.meta.url), png);
console.log('icon written', N, 'x', N);
