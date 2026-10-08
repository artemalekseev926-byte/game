export const TICK = 0.25;
export const VERSION = '1.0.0';

export const PLAYER_COLORS = [
  '#d94141', '#3f7fe0', '#47b347', '#e0b23a', '#9b55d6', '#e07a2f',
  '#2fc2c2', '#d655a3', '#8a6b3f', '#7c8c2e', '#5d6fd6', '#c2c2c2',
];

export const TERRAIN = {
  plain: { name: 'Равнина', def: 1.0, grow: 1.0, color: '#7fae5a' },
  forest: { name: 'Лес', def: 1.15, grow: 0.9, color: '#4f8a42' },
  hills: { name: 'Горы', def: 1.35, grow: 0.75, color: '#9a8a6a' },
  desert: { name: 'Пустыня', def: 0.95, grow: 0.6, color: '#d8c27a' },
  snow: { name: 'Тундра', def: 1.1, grow: 0.55, color: '#dfe7ea' },
};
export const TERRAIN_KEYS = Object.keys(TERRAIN);

export const UNITS = {
  inf: { name: 'Пехота', short: 'ПЕХ', atk: 1.0, def: 1.3, cost: 3, mp: 1, upkeep: 0.012, speed: 1.0, needs: null, research: 'inf' },
  tank: { name: 'Танки', short: 'ТНК', atk: 4.5, def: 3.0, cost: 18, mp: 2, upkeep: 0.06, speed: 1.5, needs: 'factory', research: 'armor' },
  art: { name: 'Артиллерия', short: 'АРТ', atk: 3.5, def: 1.6, cost: 14, mp: 2, upkeep: 0.045, speed: 0.75, needs: 'factory', research: 'art', fortPierce: 0.6 },
};
export const UNIT_KEYS = Object.keys(UNITS);
export const ARMY_BASE_SPEED = 1.8;

export const BUILDINGS = {
  fort: { name: 'Укрепления', icon: 'fort', max: 3, cost: 60, upkeep: 0.25, time: 8, desc: '+35% к обороне за уровень' },
  factory: { name: 'Фабрика', icon: 'factory', max: 3, cost: 120, upkeep: 0, time: 12, desc: '+3$/с за уровень, позволяет выпускать танки и артиллерию' },
  house: { name: 'Жилые дома', icon: 'house', max: 3, cost: 70, upkeep: 0, time: 8, desc: '+35% к населению и +25% к росту за уровень' },
  aa: { name: 'ПВО', icon: 'aa', max: 3, cost: 110, upkeep: 0.4, time: 10, desc: 'Сбивает БПЛА и ракеты в радиусе' },
  airbase: { name: 'Аэродром БПЛА', icon: 'airbase', max: 2, cost: 140, upkeep: 0.5, time: 12, req: ['drone', 1], desc: 'Запуск БПЛА. Уровень увеличивает дальность и скорострельность' },
  silo: { name: 'Ракетная шахта', icon: 'silo', max: 2, cost: 250, upkeep: 1.0, time: 18, req: ['missile', 1], desc: 'Запуск ракет. Уровень ускоряет перезарядку' },
};
export const BUILDING_KEYS = Object.keys(BUILDINGS);

export const RESEARCH = {
  econ: { name: 'Экономика', max: 5, cost: 100, desc: '+10% налогов и выпуска фабрик' },
  logistics: { name: 'Логистика', max: 3, cost: 90, desc: '+12% скорости армий, -10% содержания войск' },
  inf: { name: 'Стрелковое оружие', max: 5, cost: 80, desc: '+15% атаки и обороны пехоты' },
  armor: { name: 'Бронетехника', max: 5, cost: 120, desc: '+15% атаки и обороны танков' },
  art: { name: 'Артиллерия', max: 5, cost: 110, desc: '+15% атаки артиллерии, лучше пробивает укрепления' },
  fort: { name: 'Фортификация', max: 3, cost: 100, desc: '+10% к эффекту укреплений' },
  drone: { name: 'БПЛА', max: 3, cost: 150, desc: '1: ударные БПЛА и аэродромы, 2: дроны-камикадзе, 3: рой дронов' },
  missile: { name: 'Ракеты', max: 3, cost: 200, desc: '1: шахты и тактические ракеты, 2: средняя дальность, 3: МБР' },
  aa: { name: 'Системы ПВО', max: 3, cost: 130, desc: '+шанс перехвата и скорострельность ПВО' },
};
export const RESEARCH_KEYS = Object.keys(RESEARCH);
export const researchCost = (key, lvl) => Math.round(RESEARCH[key].cost * Math.pow(lvl + 1, 1.6));
export const researchTime = (lvl) => 15 + 12 * lvl;

export const DRONES = {
  strike: { name: 'Ударный БПЛА', cost: 35, lvl: 1, dmg: 26, bldg: 0, count: 1 },
  kamikaze: { name: 'Дрон-камикадзе', cost: 50, lvl: 2, dmg: 10, bldg: 1, count: 1 },
  swarm: { name: 'Рой дронов', cost: 120, lvl: 3, dmg: 22, bldg: 0, count: 5 },
};
export const DRONE_SPEED = 6;
export const droneRange = (airbaseLvl, droneLvl) => 26 + 10 * airbaseLvl + 8 * droneLvl;
export const droneCooldown = (airbaseLvl) => 8 / airbaseLvl;

export const MISSILE = { name: 'Ракета', cost: 180, speed: 10 };
export const missileRange = (lvl) => (lvl >= 3 ? 9999 : lvl === 2 ? 90 : 50);
export const missileTroopLoss = (lvl) => 0.4 + 0.1 * lvl;
export const siloCooldown = (siloLvl) => (siloLvl >= 2 ? 15 : 25);

export const aaRadius = (lvl) => 8 + 3 * lvl;
export const aaCooldown = (lvl, research) => 2.2 / (lvl + 0.5 * research);
export const aaHitChance = (kind, lvl, research) =>
  kind === 'missile' ? 0.12 + 0.08 * lvl + 0.06 * research : 0.3 + 0.12 * lvl + 0.07 * research;

export const ECON = {
  startMoney: 400,
  startManpower: 60,
  taxPerPop: 0.04,
  manpowerPerPop: 0.018,
  factoryIncome: 3,
  popBase: 8,
  popPerTile: 0.9,
  growth: 0.02,
  overextensionFree: 10,
  overextension: 0.012,
  unrestTime: 60,
  debtDesertion: 0.02,
  buildingScale: 0.08,
  neutralGarrison: 0.6,
  maxMoney: 1e7,
};

export const DIFFICULTY = {
  easy: { name: 'Лёгкий', income: 0.75, think: 3.0, aggression: 1.6 },
  normal: { name: 'Нормальный', income: 1.0, think: 2.0, aggression: 1.3 },
  hard: { name: 'Сложный', income: 1.3, think: 1.2, aggression: 1.1 },
};
