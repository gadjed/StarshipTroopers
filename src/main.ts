import './style.css';
import { FpsGovernor } from './app/governor';
import { Hud, type AppState, type HudStats } from './hud/hud';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import { MAX_BUGS, WORLD_SIZE } from './shared/constants';
import {
  B_CORNER,
  B_MINE,
  B_WALL,
  BUILDINGS,
  FX_GHOST,
  FX_GHOST_WALL,
  FX_HEAD,
  FX_SECTOR,
  TOOL_DEMOLISH,
  TOOL_NONE,
  TOOL_ORBITAL,
  isWeapon,
  pushFx,
} from './shared/defense';
import { MODE_BREAKTHROUGH, MODE_SIEGE, type SimParams } from './sim/config';
import { randomSeed } from './sim/rng';
import { Simulation } from './sim/simulation';
import { CORNER_SNAP, MINEFIELD_COUNT, MINEFIELD_RADIUS, WALL_MAX } from './sim/defense';
import { warmUpJit } from './sim/warmup';

/** Скільки секунд показуємо «БУНКЕР ЗНИЩЕНО» перед новою мапою. */
const GAME_OVER_DELAY = 4;
/** Крок ряду мінних полів при протягуванні. */
const MINE_ROW_STEP = MINEFIELD_RADIUS * 2 + 2;

// Захист від «спіралі смерті»: якщо кадр дуже довгий, не наздоганяємо симуляцію нескінченно.
// Якщо крок дорожчий за кадр, краще сповільнити симуляцію, ніж обвалити FPS.
const MAX_STEPS_PER_FRAME = 2;

// Параметри URL для відтворюваних тестів, напр.:
//   ?seed=42&mode=siege&limit=100000&spawn=20000&warmup=40&zoom=6&cx=500&cy=500&flow=1&grid=1&hz=60
//   &prep=0 (без хвилини підготовки) &demo=1 (зразкова оборона) &zones=1 (робочі зони всієї зброї) &auto=0 (без авто-ліміту) &waves=0 (ручний спавн) &destroy=2 (сила руйнування) &jit=0 (без прогріву)
const url = new URLSearchParams(location.search);
const urlNum = (key: string, fallback: number) => {
  const v = Number(url.get(key));
  return url.has(key) && Number.isFinite(v) ? v : fallback;
};

const state: AppState = {
  paused: false,
  simHz: urlNum('hz', 30) === 60 ? 60 : 30,
  showFlow: url.get('flow') === '1',
  showGrid: url.get('grid') === '1',
  maxAlive: Math.min(MAX_BUGS, Math.max(1000, urlNum('limit', MAX_BUGS))),
  autoLimit: url.get('auto') !== '0',
  autoWaves: url.get('waves') !== '0' && !url.has('spawn'),
  destruction: urlNum('destroy', 1),
  spawnRate: Math.max(0, urlNum('spawn', 2_000)),
  speedMul: urlNum('speed', 1),
  pushStrength: urlNum('push', 1),
  avoidStrength: urlNum('avoid', 1),
  congestionStrength: urlNum('jam', 1),
  mode: url.get('mode') === 'siege' ? MODE_SIEGE : MODE_BREAKTHROUGH,
  tool: TOOL_NONE,
  showZones: url.get('zones') === '1',
};

// SimParams — окремий об'єкт, бо при перенесенні у Worker він стане повідомленням / SAB-структурою.
const params: SimParams = {
  maxAlive: state.maxAlive,
  hardLimit: state.maxAlive,
  autoWaves: state.autoWaves ? 1 : 0,
  destruction: state.destruction,
  spawnRate: state.spawnRate,
  speedMul: state.speedMul,
  pushStrength: state.pushStrength,
  avoidStrength: state.avoidStrength,
  congestionStrength: state.congestionStrength,
  mode: state.mode,
};
// Авто-ліміт: стартуємо з помірного значення, далі регулятор підлаштовується під залізо.
const governor = new FpsGovernor(30_000);
const syncParams = () => {
  params.hardLimit = state.maxAlive;
  params.maxAlive = state.autoLimit ? Math.min(state.maxAlive, governor.limit) : state.maxAlive;
  params.autoWaves = state.autoWaves ? 1 : 0;
  params.destruction = state.destruction;
  params.spawnRate = state.spawnRate;
  params.speedMul = state.speedMul;
  params.pushStrength = state.pushStrength;
  params.avoidStrength = state.avoidStrength;
  params.congestionStrength = state.congestionStrength;
  params.mode = state.mode;
};

syncParams();

const seedFromUrl = urlNum('seed', 0);
const sim = new Simulation(WORLD_SIZE, MAX_BUGS, params, seedFromUrl > 0 ? seedFromUrl : randomSeed());


const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
renderer.setMap(sim.map);
const camera = new Camera();
renderer.resize();
camera.setViewport(canvas.width, canvas.height);
camera.fit(WORLD_SIZE);
if (url.has('zoom')) {
  camera.zoom *= urlNum('zoom', 1);
  camera.x = urlNum('cx', camera.x);
  camera.y = urlNum('cy', camera.y);
}

function setSeedInUrl(): void {
  url.set('seed', String(sim.map.seed));
  history.replaceState(null, '', `?${url}`);
}

const hud = new Hud(state, {
  onChange: syncParams,
  onNewMap: () => {
    sim.loadMap(randomSeed());
    renderer.setMap(sim.map);
    setSeedInUrl();
  },
  onClear: () => sim.clear(),
  onFit: () => camera.fit(WORLD_SIZE),
  onRotate: (d) => (aimOffset += d),
  onCommander: () => sim.spawnCommander(-1),
  onStartNow: () => sim.director.skipPrep(),
});
setSeedInUrl();

// --- Введення. ЛКМ без інструмента / ПКМ / СКМ — панорама; ЛКМ з інструментом — будівництво:
// натиснути в точці, протягнути в бік ствола (для стіни — до її кінця), відпустити.
// ПКМ без протягування — скасувати інструмент.
let panning = false;
let panMoved = false;
let lastX = 0;
let lastY = 0;
let cursorX = 0;
let cursorY = 0;
let cursorOnCanvas = false;
canvas.addEventListener('pointerenter', () => (cursorOnCanvas = true));
canvas.addEventListener('pointerleave', () => (cursorOnCanvas = false));
/** Жест будівництва: точка натискання (світ). */
let gesture = false;
let gStartX = 0;
let gStartY = 0;
/** Q/E: поворот ствола відносно напрямку «від бункера», коли не протягували. */
let aimOffset = 0;
const dpr = () => canvas.width / canvas.clientWidth;
const worldX = (clientX: number) => camera.screenToWorldX(clientX * dpr());
const worldY = (clientY: number) => camera.screenToWorldY(clientY * dpr());
/** Мінімальне протягування (м), з якого воно задає напрямок. */
const dragMin = () => 12 / camera.zoom;

function defaultAim(x: number, y: number): number {
  const b = sim.map.bunker;
  return Math.atan2(y - b.y, x - b.x) + aimOffset;
}

/** Параметри прев'ю/будівництва з поточного стану жесту. */
function buildTarget() {
  const cx = worldX(cursorX);
  const cy = worldY(cursorY);
  const x = gesture ? gStartX : cx;
  const y = gesture ? gStartY : cy;
  const dragged = gesture && Math.hypot(cx - x, cy - y) > dragMin();
  const angle = dragged ? Math.atan2(cy - y, cx - x) : defaultAim(x, y);
  return { x, y, cx, cy, dragged, angle };
}

/** Стіни довші за WALL_MAX ріжемо на кілька сегментів. Кінці «прилипають» до кутів і кінців стін. */
function wallSegments(x1: number, y1: number, x2: number, y2: number, out: (ax: number, ay: number, bx: number, by: number) => void) {
  if (sim.defense.snapWallEnd(x2, y2)) {
    x2 = sim.defense.snapX;
    y2 = sim.defense.snapY;
  }
  const len = Math.hypot(x2 - x1, y2 - y1);
  const n = Math.max(1, Math.ceil(len / WALL_MAX));
  for (let k = 0; k < n; k++) {
    out(x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n, x1 + ((x2 - x1) * (k + 1)) / n, y1 + ((y2 - y1) * (k + 1)) / n);
  }
}

function mineRow(x1: number, y1: number, x2: number, y2: number, out: (x: number, y: number) => void) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const n = Math.max(0, Math.floor(len / MINE_ROW_STEP));
  for (let k = 0; k <= n; k++) out(x1 + ((x2 - x1) * k) / Math.max(1, n), y1 + ((y2 - y1) * k) / Math.max(1, n));
}

function commitBuild(): void {
  const tool = state.tool;
  const t = buildTarget();
  if (tool === TOOL_ORBITAL) sim.orbital(t.x, t.y);
  else if (tool === TOOL_DEMOLISH) sim.demolishAt(t.cx, t.cy);
  else if (tool === B_WALL) wallSegments(t.x, t.y, t.cx, t.cy, (ax, ay, bx, by) => sim.buildWall(ax, ay, bx, by));
  else if (tool === B_MINE) {
    if (t.dragged) mineRow(t.x, t.y, t.cx, t.cy, (x, y) => sim.buildMinefield(x, y, t.angle));
    else sim.buildMinefield(t.x, t.y, 0);
  }
  else if (tool === B_CORNER) sim.build(B_CORNER, t.x, t.y, t.dragged ? t.angle : 0);
  else sim.build(tool, t.x, t.y, t.angle);
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  cursorX = e.clientX;
  cursorY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 0 && state.tool !== TOOL_NONE && !gameOverAt) {
    gesture = true;
    gStartX = worldX(e.clientX);
    gStartY = worldY(e.clientY);
    // Початок стіни теж «прилипає» до кута або кінця іншої стіни.
    if (state.tool === B_WALL && sim.defense.snapWallEnd(gStartX, gStartY)) {
      gStartX = sim.defense.snapX;
      gStartY = sim.defense.snapY;
    }
    if (state.tool === TOOL_DEMOLISH) sim.demolishAt(gStartX, gStartY);
    return;
  }
  panning = true;
  panMoved = false;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  cursorX = e.clientX;
  cursorY = e.clientY;
  cursorOnCanvas = true;
  // Знесення протягуванням: усе, над чим пройшов курсор.
  if (gesture && state.tool === TOOL_DEMOLISH) sim.demolishAt(worldX(e.clientX), worldY(e.clientY));
  if (!panning) return;
  if (Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) > 0) panMoved = true;
  const k = dpr();
  camera.pan((e.clientX - lastX) * k, (e.clientY - lastY) * k);
  lastX = e.clientX;
  lastY = e.clientY;
});
canvas.addEventListener('pointerup', (e) => {
  cursorX = e.clientX;
  cursorY = e.clientY;
  if (gesture && e.button === 0) {
    if (state.tool !== TOOL_DEMOLISH) commitBuild();
    gesture = false;
    return;
  }
  if (panning && e.button === 2 && !panMoved) hud.setTool(TOOL_NONE);
  panning = false;
  canvas.classList.remove('dragging');
});
canvas.addEventListener('pointercancel', () => {
  gesture = false;
  panning = false;
  canvas.classList.remove('dragging');
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const k = dpr();
    camera.zoomAt(e.clientX * k, e.clientY * k, Math.exp(-e.deltaY * 0.0015));
  },
  { passive: false },
);
canvas.addEventListener('dblclick', () => {
  if (state.tool === TOOL_NONE) camera.fit(WORLD_SIZE);
});

/** ?demo=1 — зразкова оборона: кільце стін із кутами, по колу вся зброя, мінні поля. */
function buildDemoDefense(): void {
  const c = WORLD_SIZE / 2;
  const R = 62;
  const N = 14;
  for (let k = 0; k < N; k++) {
    const a0 = (k / N) * Math.PI * 2;
    const a1 = ((k + 1) / N) * Math.PI * 2;
    sim.build(B_CORNER, c + Math.cos(a0) * R, c + Math.sin(a0) * R, a0);
    if (k % 4 !== 1) sim.buildWall(c + Math.cos(a0) * R, c + Math.sin(a0) * R, c + Math.cos(a1) * R, c + Math.sin(a1) * R);
  }
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2 + 0.3;
    sim.build(k % 5, c + Math.cos(a) * 40, c + Math.sin(a) * 40, a);
  }
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.6;
    sim.buildMinefield(c + Math.cos(a) * 100, c + Math.sin(a) * 100, a);
  }
}

/** Прев'ю будівництва: привид будівлі, робоча зона з напрямком ствола, валідність кольором. */
function pushPreview(): void {
  const tool = state.tool;
  if (tool === TOOL_NONE || gameOverAt) return;
  const fx = sim.fxFrame;
  const d = sim.defense;
  const t = buildTarget();
  if (tool === TOOL_ORBITAL) {
    pushFx(fx, t.x, t.y, 0, 0, 40, FX_GHOST, 2, 0);
    pushFx(fx, t.x, t.y, 0, 0, 3, FX_GHOST, 2, 0);
  } else if (tool === TOOL_DEMOLISH) {
    const b = d.buildingAt(t.cx, t.cy);
    if (b >= 0) {
      const type = d.bType[b];
      const r = type === B_WALL ? d.bLen[b] / 2 + 1 : BUILDINGS[type].radius + 1.5;
      pushFx(fx, d.bX[b], d.bY[b], 0, 0, r, FX_GHOST, 2, type === B_CORNER ? 1 : 0);
    }
  } else if (tool === B_WALL) {
    if (gesture) {
      wallSegments(t.x, t.y, t.cx, t.cy, (ax, ay, bx, by) => {
        const ok = d.canPlace(B_WALL, ax, ay, bx, by);
        pushFx(fx, ax, ay, bx, by, BUILDINGS[B_WALL].radius, FX_GHOST_WALL, ok ? 1 : 2, 0);
      });
    }
    // Маркер «прилипання» кінця: кільце на куті / кінці стіни.
    const snapped = d.snapWallEnd(t.cx, t.cy);
    pushFx(fx, snapped ? d.snapX : t.cx, snapped ? d.snapY : t.cy, 0, 0, snapped ? CORNER_SNAP : 1, FX_GHOST, 1, 0);
  } else if (tool === B_MINE) {
    const angle = t.dragged ? t.angle : 0;
    const each = (x: number, y: number) => {
      for (let k = 0; k < MINEFIELD_COUNT; k++) {
        d.minefieldSpot(x, y, angle, k);
        const mx = d.snapX;
        const my = d.snapY;
        const ok = d.canPlace(B_MINE, mx, my);
        pushFx(fx, mx, my, 0, 0, BUILDINGS[B_MINE].radius, FX_GHOST, ok ? 1 : 2, 0);
        pushFx(fx, mx, my, 0, 0, BUILDINGS[B_MINE].range, FX_SECTOR, Math.PI, 0);
      }
    };
    if (t.dragged) mineRow(t.x, t.y, t.cx, t.cy, each);
    else each(t.x, t.y);
  } else if (tool === B_CORNER) {
    const ok = d.canPlace(B_CORNER, t.x, t.y);
    pushFx(fx, t.x, t.y, 0, 0, BUILDINGS[B_CORNER].radius, FX_GHOST, ok ? 1 : 2, 1);
  } else if (isWeapon(tool)) {
    const def = BUILDINGS[tool];
    const ok = d.canPlace(tool, t.x, t.y);
    const mode = ok ? 1 : 2;
    pushFx(fx, t.x, t.y, def.minRange, mode, def.range, FX_SECTOR, def.arc / 2, t.angle);
    pushFx(fx, t.x, t.y, 0, 0, def.radius, FX_GHOST, mode, 0);
    pushFx(fx, t.x, t.y, 0, -mode, def.radius, FX_HEAD, tool, t.angle);
  }
}

// --- Головний цикл: фіксований крок симуляції, рендер з інтерполяцією.
const stats: HudStats = {
  fps: 0,
  frameMs: 0,
  simMs: 0,
  stepMs: 0,
  steps: 0,
  renderMs: 0,
  gpuMs: -1,
  alive: 0,
  breakthroughs: 0,
  eaten: 0,
  rocksDestroyed: 0,
  craters: 0,
  coreFrac: 1,
  kills: 0,
  buildings: 0,
  projectiles: 0,
  gameOverIn: 0,
  commanders: 0,
  commanderKills: 0,
  limitNow: 0,
  autoLimit: true,
  wave: 0,
  inWave: false,
  waveSide: -1,
  nextWaveIn: 0,
  prepLeft: 0,
  autoWaves: true,
  jobKind: 0,
  spawnRate: 0,
  seed: 0,
  coverage: 0,
  shared: sim.sharedMemory,
  cursorX: 0,
  cursorY: 0,
  worldSize: WORLD_SIZE,
};
const debug = { flow: false, grid: false };
const ema = (prev: number, v: number, k = 0.1) => prev + (v - prev) * k;

let accumulator = 0;
let lastTime = performance.now();
let lastHudUpdate = 0;
let jitWarmupMs = 0;
let gameOverAt = 0;

function frame(now: number): void {
  const frameDt = Math.min(Math.max(0, now - lastTime) / 1000, 0.25);
  lastTime = now;

  if (renderer.resize()) camera.setViewport(canvas.width, canvas.height);

  const dt = 1 / state.simHz;
  // Game over: зупиняємо симуляцію, показуємо банер, потім — нова мапа.
  if (sim.gameOver && !gameOverAt) gameOverAt = now;
  if (gameOverAt && now - gameOverAt > GAME_OVER_DELAY * 1000) {
    gameOverAt = 0;
    sim.loadMap(randomSeed());
    renderer.setMap(sim.map);
    setSeedInUrl();
  }
  if (!state.paused && !gameOverAt) accumulator += frameDt;

  const t0 = performance.now();
  let steps = 0;
  while (accumulator >= dt && steps < MAX_STEPS_PER_FRAME) {
    sim.step(dt);
    accumulator -= dt;
    steps++;
  }
  if (steps === MAX_STEPS_PER_FRAME && accumulator > dt) accumulator = dt * 0.5; // відстаємо — скидаємо борг
  if (steps > 0) sim.packRender();
  const t1 = performance.now();

  debug.flow = state.showFlow;
  debug.grid = state.showGrid;
  // Зону будівлі показуємо, лише коли курсор над нею (або всі — клавішею Z).
  const hovered = cursorOnCanvas && !gesture ? sim.defense.buildingAt(worldX(cursorX), worldY(cursorY)) : -1;
  sim.packFx(state.showZones, hovered, now / 1000);
  pushPreview();
  renderer.render(camera, sim.frame, accumulator / dt, debug, sim.hashView, now / 1000, sim.fxFrame);
  const t2 = performance.now();

  // FPS = 1 / середній час кадру (а не середнє від 1/dt — воно завищене, коли кадри чергуються
  // «з кроком симуляції» / «без кроку»).
  stats.frameMs = ema(stats.frameMs, frameDt * 1000, 0.05);
  stats.fps = stats.frameMs > 0 ? 1000 / stats.frameMs : 0;
  stats.simMs = ema(stats.simMs, t1 - t0);
  if (steps > 0) stats.stepMs = ema(stats.stepMs, (t1 - t0) / steps);
  stats.steps = ema(stats.steps, steps);
  stats.renderMs = ema(stats.renderMs, t2 - t1);
  stats.gpuMs = renderer.gpuTimer.lastMs;

  // Авто-ліміт FPS: заміри цього кадру → (раз на 0.5 с) новий ліміт спавну.
  governor.sample(steps > 0 ? (t1 - t0) / steps : 0, sim.store.aliveCount, frameDt * 1000);
  if (state.autoLimit && !state.paused) {
    governor.update(now, sim.store.aliveCount, state.maxAlive);
    params.maxAlive = Math.min(state.maxAlive, governor.limit);
  }

  if (now - lastHudUpdate > 250) {
    lastHudUpdate = now;
    stats.alive = sim.store.aliveCount;
    stats.breakthroughs = sim.breakthroughs;
    stats.eaten = sim.eaten;
    stats.rocksDestroyed = sim.rocksDestroyed;
    stats.craters = sim.erosion.count;
    stats.coreFrac = sim.map.coreHp / sim.map.coreHpMax;
    stats.kills = sim.defense.kills;
    stats.buildings = sim.defense.buildingCount;
    stats.projectiles = sim.defense.projectileCount;
    stats.commanders = sim.commanderCount;
    stats.commanderKills = sim.defense.commanderKills;
    stats.gameOverIn = gameOverAt ? GAME_OVER_DELAY - (now - gameOverAt) / 1000 : 0;
    stats.limitNow = params.maxAlive;
    stats.autoLimit = state.autoLimit;
    stats.autoWaves = state.autoWaves;
    stats.wave = sim.director.wave;
    stats.inWave = sim.director.inWave;
    stats.waveSide = sim.director.side;
    stats.nextWaveIn = sim.director.secondsToNextWave;
    stats.prepLeft = sim.director.prepLeft;
    stats.jobKind = sim.jobKind;
    stats.spawnRate = sim.spawnRateNow;
    stats.seed = sim.map.seed;
    stats.coverage = sim.map.coverage;
    const k = dpr();
    stats.cursorX = camera.screenToWorldX(cursorX * k);
    stats.cursorY = camera.screenToWorldY(cursorY * k);
    hud.update(stats);
  }

  requestAnimationFrame(frame);
}
/**
 * Старт: спершу показуємо мапу з написом «прогрів», і вже в наступному таску — прогрів JIT
 * (~2 с, див. sim/warmup.ts) та опційний ?warmup=N. Інакше сторінка 2 с виглядала б завислою.
 */
sim.packRender();
sim.packFx(state.showZones, -1, 0);
renderer.render(camera, sim.frame, 1, debug, sim.hashView, 0, sim.fxFrame);
requestAnimationFrame(() =>
  setTimeout(() => {
    if (url.get('jit') !== '0') jitWarmupMs = warmUpJit(WORLD_SIZE, 1);
    if (url.get('demo') === '1') buildDemoDefense();
    if (url.get('prep') === '0') sim.director.skipPrep();
    // ?warmup=N — одразу прокрутити N секунд симуляції (щоб бенчмаркати вже сформовану орду).
    for (let s = 0, steps = urlNum('warmup', 0) * state.simHz; s < steps; s++) sim.step(1 / state.simHz);
    sim.packRender();
    document.getElementById('boot')?.remove();
    lastTime = performance.now();
    requestAnimationFrame(frame);
  }, 0),
);

// Доступ з консолі для експериментів: window.horde.sim.params, window.horde.sim.store…
(window as unknown as { horde: unknown }).horde = { sim, renderer, camera, state, stats, governor, jitWarmupMs: () => jitWarmupMs };
