export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + next() * (hi - lo),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}

export function hash2(seed, x, y) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function makeNoise(seed) {
  const rng = makeRng(seed);
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) { perm[i] = i; vals[i] = rng.next(); }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const lattice = (x, y) => vals[perm[(perm[x & 255] + y) & 511]];
  const smooth = (t) => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = lattice(xi, yi), b = lattice(xi + 1, yi);
    const c = lattice(xi, yi + 1), d = lattice(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  return (x, y, octaves = 4) => {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += noise(x * freq, y * freq) * amp;
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  };
}

const D = 0.7071067811865476;
const GX = new Float64Array([1, -1, 0, 0, D, -D, D, -D, 0.9238795325112867, -0.9238795325112867, 0.3826834323650898, -0.3826834323650898, 0.9238795325112867, -0.9238795325112867, 0.3826834323650898, -0.3826834323650898]);
const GY = new Float64Array([0, 0, 1, -1, D, D, -D, -D, 0.3826834323650898, 0.3826834323650898, 0.9238795325112867, 0.9238795325112867, -0.3826834323650898, -0.3826834323650898, -0.9238795325112867, -0.9238795325112867]);

export function makeGradNoise(seed) {
  const rng = makeRng(seed ^ 0x2545f491);
  const perm = new Uint16Array(2048);
  for (let i = 0; i < 1024; i++) perm[i] = i;
  for (let i = 1023; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  for (let i = 0; i < 1024; i++) perm[i + 1024] = perm[i];
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 1023, Y = yi & 1023;
    const p0 = perm[X], p1 = perm[X + 1];
    const h00 = perm[p0 + Y] & 15, h10 = perm[p1 + Y] & 15;
    const h01 = perm[p0 + Y + 1] & 15, h11 = perm[p1 + Y + 1] & 15;
    const n00 = GX[h00] * xf + GY[h00] * yf;
    const n10 = GX[h10] * (xf - 1) + GY[h10] * yf;
    const n01 = GX[h01] * xf + GY[h01] * (yf - 1);
    const n11 = GX[h11] * (xf - 1) + GY[h11] * (yf - 1);
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const a = n00 + (n10 - n00) * u, b = n01 + (n11 - n01) * u;
    return (a + (b - a) * v) * 1.41;
  };
  const fbm = (x, y, octaves = 4, gain = 0.5) => {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += noise(x * freq + o * 17.31, y * freq - o * 9.73) * amp;
      norm += amp; amp *= gain; freq *= 2;
    }
    return sum / norm;
  };
  const ridged = (x, y, octaves = 4) => {
    let sum = 0, amp = 1, freq = 1, norm = 0, w = 1;
    for (let o = 0; o < octaves; o++) {
      let r = 1 - Math.abs(noise(x * freq - o * 23.17, y * freq + o * 5.91));
      r *= r * w;
      w = r < 1 ? r : 1;
      sum += r * amp;
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  };
  return { noise, fbm, ridged };
}
