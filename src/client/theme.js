export const THEMES = {
  dark: {
    name: 'dark',
    bg: '#060a11',
    edge: 'rgba(0,0,0,0.55)',
    deep: [11, 27, 47], mid: [17, 45, 73], shallow: [32, 78, 108], foam: [118, 170, 196], lake: [30, 72, 102],
    land: [
      null, null,
      [96, 112, 72],
      [58, 86, 56],
      [170, 148, 100],
      [120, 113, 84],
      [122, 115, 108],
      [204, 211, 218],
    ],
    peak: [196, 200, 206],
    beach: [150, 140, 104],
    landGain: 0.92,
    shade: 1.5,
    grain: 9,
    detail: 10,
    foamA: 0.5,
    blot: 0.07,
    fillA: 0.5, rimA: 0.62, darkA: 0.95,
    darkK: 0.42, rimK: 0.38,
    falloutHi: [156, 236, 58], falloutLo: [18, 38, 14], falloutA: 0.66,
    label: '#ffffff', labelSub: 'rgba(235,240,248,0.92)', labelStroke: 'rgba(4,7,12,0.82)',
    ring: 'rgba(6,9,15,0.88)', icon: '#ffffff', badge: '#0d121b', badgeText: '#ffffff',
    rail: [38, 42, 50], tie: [112, 92, 70], railHi: [150, 158, 168],
    route: [255, 214, 120], routeA: 0.42,
    hull: [176, 184, 196], deck: [96, 104, 116], wake: 'rgba(210,235,255,0.5)',
    aaOwn: [96, 196, 255], aaAlly: [120, 226, 150], aaEnemy: [255, 92, 84],
    ok: [96, 226, 128], bad: [255, 92, 80], warn: [255, 196, 70],
    select: '#ffffff', hover: 'rgba(255,255,255,0.7)',
    progress: '#ffd25a', reload: 'rgba(160,170,185,0.9)',
    shadow: 'rgba(0,0,0,0.42)',
    smoke: [70, 72, 78],
    floatGold: '#ffd25a',
  },
  light: {
    name: 'light',
    bg: '#cfdde6',
    edge: 'rgba(40,60,80,0.25)',
    deep: [74, 132, 182], mid: [100, 158, 204], shallow: [136, 188, 224], foam: [214, 236, 248], lake: [128, 182, 220],
    land: [
      null, null,
      [176, 196, 132],
      [118, 160, 102],
      [230, 210, 160],
      [196, 184, 140],
      [176, 166, 152],
      [244, 247, 250],
    ],
    peak: [250, 251, 253],
    beach: [232, 218, 172],
    landGain: 1,
    shade: 1.3,
    grain: 7,
    detail: 9,
    foamA: 0.65,
    blot: 0.06,
    fillA: 0.52, rimA: 0.64, darkA: 0.95,
    darkK: 0.5, rimK: 0.42,
    falloutHi: [196, 236, 52], falloutLo: [40, 62, 20], falloutA: 0.7,
    label: '#141920', labelSub: 'rgba(20,25,32,0.9)', labelStroke: 'rgba(255,255,255,0.88)',
    ring: 'rgba(255,255,255,0.95)', icon: '#ffffff', badge: '#ffffff', badgeText: '#141920',
    rail: [56, 58, 64], tie: [128, 104, 80], railHi: [120, 126, 136],
    route: [150, 96, 10], routeA: 0.5,
    hull: [84, 92, 104], deck: [176, 184, 194], wake: 'rgba(255,255,255,0.75)',
    aaOwn: [24, 120, 220], aaAlly: [30, 150, 80], aaEnemy: [220, 50, 40],
    ok: [30, 160, 70], bad: [220, 50, 40], warn: [210, 140, 20],
    select: '#111111', hover: 'rgba(0,0,0,0.6)',
    progress: '#e09a00', reload: 'rgba(90,100,115,0.9)',
    shadow: 'rgba(20,30,40,0.3)',
    smoke: [110, 112, 118],
    floatGold: '#b07800',
  },
};

export const THEME_NAMES = Object.keys(THEMES);

export function hexToRgb(hex) {
  let h = String(hex || '').trim();
  if (h[0] === '#') h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (!Number.isFinite(n) || h.length !== 6) return [160, 160, 160];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
export const lighten = (c, t) => mix(c, [255, 255, 255], t);
export const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
export const rgbStr = (c) => `rgb(${clamp255(c[0]) | 0},${clamp255(c[1]) | 0},${clamp255(c[2]) | 0})`;
export const rgba = (c, a) => `rgba(${clamp255(c[0]) | 0},${clamp255(c[1]) | 0},${clamp255(c[2]) | 0},${a})`;
export const luma = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

export function playerTones(hex, theme) {
  const t = THEMES[theme] || theme || THEMES.dark;
  const c = hexToRgb(hex);
  const l = luma(c);
  const dark = shade(c, t.darkK * (l > 0.75 ? 0.8 : 1));
  const rim = lighten(c, t.rimK);
  const marker = l > 0.78 ? shade(c, 0.78) : c;
  return { base: c, fill: c, dark, rim, marker, iconDark: l > 0.78 };
}
