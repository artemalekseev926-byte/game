import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const topo = JSON.parse(readFileSync(require.resolve('world-atlas/land-50m.json'), 'utf8'));
const land = feature(topo, topo.objects.land);

const W = 240, H = 96;
const LAT_TOP = 84, LAT_BOTTOM = -60;

const polys = [];
for (const f of land.features) {
  const g = f.geometry;
  const list = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const rings of list) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of rings[0]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    polys.push({ rings, minX, minY, maxX, maxY });
  }
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function isLand(lon, lat) {
  for (const p of polys) {
    if (lon < p.minX || lon > p.maxX || lat < p.minY || lat > p.maxY) continue;
    if (inRing(lon, lat, p.rings[0]) && !p.rings.slice(1).some((r) => inRing(lon, lat, r))) return true;
  }
  return false;
}

const rows = [];
for (let y = 0; y < H; y++) {
  let row = '';
  for (let x = 0; x < W; x++) {
    let hits = 0;
    for (const [dx, dy] of [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]]) {
      const lon = -180 + ((x + dx) / W) * 360;
      const lat = LAT_TOP - ((y + dy) / H) * (LAT_TOP - LAT_BOTTOM);
      if (isLand(lon, lat)) hits++;
    }
    row += hits >= 2 ? '#' : '.';
  }
  rows.push(row);
}

const out = `export const WORLD_W = ${W};
export const WORLD_H = ${H};
export const WORLD_LAT_TOP = ${LAT_TOP};
export const WORLD_LAT_BOTTOM = ${LAT_BOTTOM};
export const WORLD_ROWS = [
${rows.map((r) => `  '${r}',`).join('\n')}
];
`;
writeFileSync(new URL('../src/data/worldmap.js', import.meta.url), out);
console.log('worldmap written', W, 'x', H, 'land tiles:', rows.join('').split('#').length - 1);
