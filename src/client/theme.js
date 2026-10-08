// Палитры тёмной и светлой темы (для canvas; UI-цвета — в CSS-переменных)
export const THEMES = {
  dark: {
    bg: '#0b0e13',
    water: [16, 36, 62], water2: [20, 46, 76], shallow: [30, 70, 104], wave: [44, 92, 130],
    neutralMix: [70, 74, 80], neutralAmt: 0.45,
    provBorder: 0.72, countryBorder: 0.4,
    label: '#f2f2f2', labelBg: 'rgba(8,10,14,0.82)', lane: 'rgba(160,200,255,0.55)',
    select: '#ffffff', hover: 'rgba(255,255,255,0.5)', grid: 'rgba(255,255,255,0.04)',
  },
  light: {
    bg: '#e8e1cc',
    water: [98, 160, 210], water2: [108, 170, 218], shallow: [150, 200, 232], wave: [190, 225, 245],
    neutralMix: [235, 228, 205], neutralAmt: 0.35,
    provBorder: 0.8, countryBorder: 0.42,
    label: '#141414', labelBg: 'rgba(255,252,240,0.88)', lane: 'rgba(20,50,100,0.55)',
    select: '#111111', hover: 'rgba(0,0,0,0.45)', grid: 'rgba(0,0,0,0.04)',
  },
};

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
export const lighten = (c, t) => mix(c, [255, 255, 255], t);
export const rgbStr = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
