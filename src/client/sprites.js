const PAL = {
  k: '#14161a', w: '#f4f4f4', g: '#9aa0a8', d: '#5a6068', r: '#d8423a', y: '#f2c23a',
  b: '#5ab0f0', o: '#e8862e', n: '#7a5a3a', l: '#c8ccd2', G: '#4caf50',
};

export const SPRITES = {
  fort: [
    'k.k..k.k',
    'kgk..kgk',
    'kgkkkkgk',
    'kggggggk',
    'kgddddgk',
    'kgdkkdgk',
    'kgdkkdgk',
    'kkkkkkkk',
  ],
  factory: [
    '.kk.....',
    '.gk.....',
    '.gk..k..',
    '.gk.kgk.',
    'kgkkgggk',
    'kgygygyk',
    'kggggggk',
    'kkkkkkkk',
  ],
  house: [
    '...kk...',
    '..krrk..',
    '.krrrrk.',
    'krrrrrrk',
    '.kwwwwk.',
    '.kwbknk.',
    '.kwbknk.',
    '.kkkkkk.',
  ],
  aa: [
    '.....y..',
    '....k...',
    '...kgk..',
    '..kgk...',
    '.kgk.y..',
    '.kdk....',
    'kddddk..',
    'kkkkkk..',
  ],
  silo: [
    '...kk...',
    '..kwwk..',
    '..kwwk..',
    '..krrk..',
    '..kwwk..',
    'kkkwwkkk',
    'kdkddkdk',
    'kkkkkkkk',
  ],
  airbase: [
    'kk....kk',
    'kgk..kgk',
    '.kgkkgk.',
    '..kXXk..',
    '..kXXk..',
    '.kgkkgk.',
    'kgk..kgk',
    'kk....kk',
  ],
  inf: [
    '..kkk..',
    '..kwk..',
    '.kXXXk.',
    'kXXXXXk',
    '.kXXXk.',
    '.kXkXk.',
    '.kk.kk.',
  ],
  tank: [
    '...kkk....',
    '..kXXXkkkk',
    '.kkXXXkk..',
    'kXXXXXXXXk',
    'kdkdkdkdkk',
    '.kkkkkkkk.',
  ],
  art: [
    '.......kk',
    '.....kkd.',
    '...kkdk..',
    '..kXXk...',
    '.kXXXXk..',
    'kdk..kdk.',
    '.k....k..',
  ],
  drone: [
    'k...k',
    '.kXk.',
    '.XwX.',
    '.kXk.',
    'k...k',
  ],
  missile: [
    '.w.',
    'wrw',
    'www',
    'kwk',
  ],
  money: [
    '.kkkk.',
    'kyyyyk',
    'kykyyk',
    'kyykyk',
    'kyyyyk',
    '.kkkk.',
  ],
  people: [
    '.kk..',
    'kwwk.',
    '.kk..',
    'kbbk.',
    'kbbk.',
    'k..k.',
  ],
  flask: [
    '.kkk.',
    '.kwk.',
    '.kwk.',
    'kGGGk',
    'kGGGk',
    '.kkk.',
  ],
};

const cache = new Map();
export function sprite(name, color = '#ffffff') {
  const key = name + color;
  if (cache.has(key)) return cache.get(key);
  const rows = SPRITES[name];
  const w = Math.max(...rows.map((r) => r.length)), h = rows.length;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      ctx.fillStyle = ch === 'X' ? color : PAL[ch] || '#ff00ff';
      ctx.fillRect(x, y, 1, 1);
    }
  });
  cache.set(key, c);
  return c;
}

const urlCache = new Map();
export function spriteURL(name, color = '#ffffff', scale = 3) {
  const key = name + color + scale;
  if (urlCache.has(key)) return urlCache.get(key);
  const s = sprite(name, color);
  const c = document.createElement('canvas');
  c.width = s.width * scale; c.height = s.height * scale;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(s, 0, 0, c.width, c.height);
  const url = c.toDataURL();
  urlCache.set(key, url);
  return url;
}
