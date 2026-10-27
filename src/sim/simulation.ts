import {
  BUG_RADIUS_JITTER,
  BUG_SPEED_JITTER,
  BUG_TYPES,
  COMMANDER_ATTACK_BUFF,
  COMMANDER_AURA,
  COMMANDER_RADIUS,
  COMMANDER_SPEED_BUFF,
  COMMANDER_TYPE,
  FLOATS_PER_BUG,
  MAX_BUG_RADIUS,
  REGULAR_BUG_TYPES,
} from '../shared/constants';
import type { BugFrame, HashGridView, MapData } from '../shared/contracts';
import { B_TESLA, FX_COMMANDER, FX_FLOATS, FX_HP_BAR, MAX_FX_INSTANCES, type FxFrame } from '../shared/defense';
import { BugStore } from './bugStore';
import {
  AGGRO_FRACTION,
  AGGRO_RADIUS,
  BUILDING_ATTACK,
  COMMANDER_INTERVAL,
  COMMANDERS_PER_WAVE_MAX,
  MAX_COMMANDERS,
  CORE_BREACH_DAMAGE,
  CORE_HP,
  CORE_REGEN_DELAY,
  CORE_REGEN_RATE,
  CORE_SIEGE_DPS,
  BITE_PRESSURE,
  BITE_RATIO,
  BITE_STUCK,
  BUNKER_RADIUS,
  CORRODE_PRESSURE,
  JOB_BUDGET_MS,
  JOB_BUDGET_URGENT_MS,
  AVOID_GAIN,
  AVOID_MAX,
  AVOID_PROBE,
  CONGESTION_GRID_SIZE,
  CONGESTION_PERIOD_STEPS,
  CONGESTION_WEIGHT,
  DETOUR_PROBE,
  DETOUR_TIME,
  JAM_DENSITY,
  STUCK_PROGRESS,
  STUCK_TIME,
  DENSITY_CELL_SIZE,
  HASH_CELL_SIZE,
  JAM_PRESSURE,
  JAM_SLOWDOWN,
  KILL_MARGIN,
  MAX_ACCEL,
  MAX_SCAN,
  MODE_BREAKTHROUGH,
  NAV_GRID_SIZE,
  NAV_INFLATE,
  EROSION_HP_PER_AREA,
  OBSTACLE_CELL_SIZE,
  OVERLAP_RELAX,
  SEPARATION_RANGE,
  SPAWN_BAND,
  type SimParams,
} from './config';
import { CongestionField } from './congestionField';
import { Defense } from './defense';
import { CRATER_DEPTH, ErosionField } from './erosion';
import { WaveDirector } from './director';
import { runToEnd, setJobDeadline, type Job } from './jobs';
import { NavFieldBuilder } from './navField';
import { ObstacleField, generateObstacles } from './obstacles';
import { mulberry32, mulberry32Int, RNG_INV30 } from './rng';
import { SpatialHash } from './spatialHash';

/**
 * Гарячі проходи (пари, рух) йдуть порціями по HOT_CHUNK жуків — кожна порція окремим викликом.
 * Причина — деоптимізація V8: коли вперше спрацьовує рідкісна гілка (перша хвиля, перший укус,
 * перша кислота…), оптимізований код викидається, і решта поточного виклику доганяється в
 * інтерпретаторі, який пакує кожне дробове число в HeapNumber. Для одного циклу на 50k жуків
 * це був крок на 100–200 мс і ~40 МБ сміття; з порціями — лише решта однієї порції, а наступна
 * вже йде в перекомпільованому коді. Бонус: порція — готова одиниця роботи для воркерів.
 */
const HOT_CHUNK = 2048;

// Таблиці типів у typed arrays — щоб гарячі цикли не лізли в масив об'єктів BUG_TYPES.
const TYPE_BITE = Float32Array.from(BUG_TYPES, (t) => t.bite);
const TYPE_CORRODE = Float32Array.from(BUG_TYPES, (t) => t.corrode);
const TYPE_ATTACK = Float32Array.from(BUG_TYPES, (t) => t.attack);
/** Радіус, вище якого жук — командир: у проході пар не бере участі (див. prepareCommanders). */
const BIG_BUG_R = MAX_BUG_RADIUS + 0.01;

// Кумулятивні ваги типів для вибору при спавні.
const TYPE_CUMULATIVE = (() => {
  const total = BUG_TYPES.reduce((s, t) => s + t.weight, 0);
  let acc = 0;
  return Float32Array.from(BUG_TYPES, (t) => (acc += t.weight / total));
})();

/**
 * Симуляція орди. Порядок кроку:
 *   cull → директор → spawn → spatial hash → розштовхування + укуси (пари) →
 *   щільність → steering + рух + колізії + корозія → руйнування скель → фонові задачі.
 *
 * Клас — лише «оркестратор» над даними: увесь стан жуків — у BugStore (SoA),
 * а цикли працюють з локальними посиланнями на typed arrays.
 */
export class Simulation {
  readonly worldSize: number;
  readonly params: SimParams;
  readonly store: BugStore;
  readonly hash: SpatialHash;
  readonly frame: BugFrame;
  readonly hashView: HashGridView;

  /** Акумулятори розштовхування, індексовані в порядку spatial hash (k), а не за слотом. */
  private readonly accSepX: Float32Array;
  private readonly accSepY: Float32Array;
  private readonly accCorrX: Float32Array;
  private readonly accCorrY: Float32Array;
  private readonly accPress: Float32Array;

  /**
   * Груба сітка щільності (жуків на од²) і її градієнт — для обходу скупчень.
   * Будується з cellCount spatial hash, тож майже безкоштовна (~4k клітинок).
   */
  private readonly densityW: number;
  private readonly density: Float32Array;
  private readonly densityGradX: Float32Array;
  private readonly densityGradY: Float32Array;

  /**
   * Командири. Їхній радіус (4.5) більший за клітинку spatial hash, тож у проході пар вони не
   * беруть участі. Натомість щокроку штампуємо їх у грубу сітку щільності (16 м):
   *   cmdNear — індекс командира, біля якого клітинка (щоб жук виштовхнувся з його кола);
   *   cmdAura — 1, якщо клітинка в аурі якогось командира.
   * Жук читає по одному байту — і жодних переборів командирів у гарячому циклі.
   */
  private readonly cmdSlot = new Int32Array(MAX_COMMANDERS);
  private readonly cmdX = new Float32Array(MAX_COMMANDERS);
  private readonly cmdY = new Float32Array(MAX_COMMANDERS);
  private readonly cmdR = new Float32Array(MAX_COMMANDERS);
  private readonly cmdNear: Int8Array;
  private readonly cmdAura: Uint8Array;
  commanderCount = 0;
  private commanderTimer = 0;
  /** Агро: найближча зброя (координати) для клітинки грубої сітки; aggroD — квадрат відстані (∞ — немає). */
  private readonly aggroX: Float32Array;
  private readonly aggroY: Float32Array;
  private readonly aggroD: Float32Array;
  private aggroOn = false;
  private lastWave = 0;

  map!: MapData;
  readonly director: WaveDirector;
  /** Оборона гравця: будівлі, снаряди, вогонь. */
  readonly defense: Defense;
  /** FX-інстанси для рендеру (оборона, снаряди, ефекти). */
  readonly fxFrame: FxFrame;
  private readonly navBuilder: NavFieldBuilder;
  private readonly congestion: CongestionField;
  private obstacles!: ObstacleField;
  /** Кратери локальної корозії скель. */
  readonly erosion: ErosionField;
  private rng: () => number;

  /** Поточна фонова задача: 0 — немає, 1 — перебудова flow field, 2 — поле заторів. */
  jobKind = 0;
  private job: Job | null = null;
  private navDirty = false;
  /** Поле застаріло через дію гравця: перебудова термінова (перериває поточну, більший бюджет). */
  private navUrgent = false;
  private jobUrgent = false;
  private lastCongestionTick = -Infinity;

  breakthroughs = 0;
  /** Жуків, з'їдених своїми в тісняві. */
  eaten = 0;
  /** Зруйнованих скель. */
  rocksDestroyed = 0;
  /** Фактична швидкість спавну (ручна або від директора), жуків/с. */
  spawnRateNow = 0;
  tick = 0;
  private spawnAcc = 0;
  /** Секунд від останньої шкоди ядру (для його регенерації). */
  private coreSinceHit = 0;
  /** Зібрано щокадру для рендеру: регенерація змінила вигляд будівель. */
  private regenAcc = 0;

  constructor(worldSize: number, capacity: number, params: SimParams, seed: number) {
    this.worldSize = worldSize;
    this.params = params;
    const shared = typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true;
    this.store = new BugStore(capacity, shared);
    this.hash = new SpatialHash(worldSize, HASH_CELL_SIZE, capacity);
    this.frame = { instances: new Float32Array(capacity * FLOATS_PER_BUG), count: 0, version: 0 };
    this.accSepX = new Float32Array(capacity);
    this.accSepY = new Float32Array(capacity);
    this.accCorrX = new Float32Array(capacity);
    this.accCorrY = new Float32Array(capacity);
    this.accPress = new Float32Array(capacity);
    this.densityW = Math.ceil(worldSize / DENSITY_CELL_SIZE);
    const dn = this.densityW * this.densityW;
    this.density = new Float32Array(dn);
    this.densityGradX = new Float32Array(dn);
    this.densityGradY = new Float32Array(dn);
    this.cmdNear = new Int8Array(dn).fill(-1);
    this.cmdAura = new Uint8Array(dn);
    this.aggroX = new Float32Array(dn);
    this.aggroY = new Float32Array(dn);
    this.aggroD = new Float32Array(dn).fill(Infinity);
    this.hashView = { w: this.hash.w, h: this.hash.h, cellSize: HASH_CELL_SIZE, counts: this.hash.cellCount };
    this.rng = mulberry32Int(seed ^ 0x9e3779b9);
    this.director = new WaveDirector(mulberry32(seed ^ 0x51ed270b));
    this.navBuilder = new NavFieldBuilder(worldSize, NAV_GRID_SIZE);
    const c = worldSize / 2;
    this.congestion = new CongestionField(worldSize, CONGESTION_GRID_SIZE, c, c, BUNKER_RADIUS);
    this.erosion = new ErosionField(worldSize, EROSION_HP_PER_AREA);
    this.defense = new Defense(this.store, this.hash, this.density, this.densityW, DENSITY_CELL_SIZE);
    this.fxFrame = { instances: new Float32Array(MAX_FX_INSTANCES * FX_FLOATS), count: 0, under: 0 };
    this.loadMap(seed);
  }

  get sharedMemory(): boolean {
    return typeof SharedArrayBuffer !== 'undefined' && this.store.buffer instanceof SharedArrayBuffer;
  }

  /** Нова мапа: перешкоди, flow field. Усі жуки зникають. Алокації тут дозволені — це не гарячий цикл. */
  loadMap(seed: number): void {
    const ws = this.worldSize;
    const set = generateObstacles(seed, ws);
    const bunker = { x: ws / 2, y: ws / 2, r: BUNKER_RADIUS };
    this.job = null;
    this.jobKind = 0;
    this.navDirty = false;
    this.navUrgent = false;
    this.jobUrgent = false;
    this.erosion.reset();
    const nav = runToEnd(this.navBuilder.build(set, this.erosion, bunker.x, bunker.y, bunker.r, NAV_INFLATE));
    // Грід перешкод «роздутий» на радіус командира — найбільшого, хто з ними стикається.
    this.obstacles = new ObstacleField(set, ws, OBSTACLE_CELL_SIZE, COMMANDER_RADIUS * (1 + BUG_RADIUS_JITTER), this.erosion);
    this.congestion.resetCost();
    runToEnd(this.congestion.rebuild(nav));
    const prev = this.map;
    this.map = {
      seed,
      worldSize: ws,
      obstacles: set,
      erosion: this.erosion,
      nav,
      bunker,
      coverage: this.navBuilder.coverage,
      coreHp: CORE_HP,
      coreHpMax: CORE_HP,
      obstacleVersion: prev ? prev.obstacleVersion + 1 : 0,
      navVersion: prev ? prev.navVersion + 1 : 0,
    };
    this.rocksDestroyed = 0;
    this.rng = mulberry32Int(seed ^ 0x9e3779b9);
    this.defense.setMap(this.map, this.obstacles);
    this.clear();
  }

  /** Прибирає жуків і снаряди, відновлює ядро бункера. Будівлі лишаються. */
  clear(): void {
    this.store.reset();
    this.defense.clearProjectiles();
    this.defense.kills = 0;
    this.map.coreHp = this.map.coreHpMax;
    this.breakthroughs = 0;
    this.eaten = 0;
    this.spawnAcc = 0;
    this.commanderCount = 0;
    this.commanderTimer = 0;
    this.lastWave = 0;
    this.defense.commanderKills = 0;
    this.director.reset();
    this.hash.count = 0;
    this.hash.cellCount.fill(0);
    this.packRender();
  }

  kill(i: number): void {
    this.store.free(i);
  }

  /** Командир на краю мапи (side: 0..3, −1 — випадковий). Повертає слот або −1. */
  spawnCommander(side = -1): number {
    if (this.commanderCount >= MAX_COMMANDERS) return -1;
    const store = this.store;
    // На межі ліміту командир займає місце звичайного жука (інакше його зняв би cullExcess).
    if (store.aliveCount >= this.params.hardLimit) {
      for (let j = store.highWater - 1; j >= 0; j--) {
        if (store.alive[j] && store.type[j] !== COMMANDER_TYPE) {
          store.free(j);
          break;
        }
      }
    }
    const i = store.allocate();
    if (i < 0) return -1;
    const R = RNG_INV30;
    const ws = this.worldSize;
    const sd = side >= 0 ? side : (this.rng() * R * 4) | 0;
    const along = 40 + this.rng() * R * (ws - 80);
    const depth = 8;
    const x = sd === 0 ? along : sd === 1 ? ws - depth : sd === 2 ? along : depth;
    const y = sd === 0 ? depth : sd === 1 ? along : sd === 2 ? ws - depth : along;
    const def = BUG_TYPES[COMMANDER_TYPE];
    store.posX[i] = store.prevX[i] = x;
    store.posY[i] = store.prevY[i] = y;
    store.velX[i] = store.velY[i] = 0;
    store.radius[i] = def.radius;
    store.maxSpeed[i] = def.speed;
    store.shade[i] = 0.5;
    store.type[i] = COMMANDER_TYPE;
    store.hp[i] = def.hp;
    store.bestDist[i] = Infinity;
    store.stuckTime[i] = 0;
    store.detourTime[i] = 0;
    store.detourSide[i] = 1;
    store.biteReady[i] = 0;
    const k = this.commanderCount++;
    this.cmdSlot[k] = i;
    this.cmdX[k] = x;
    this.cmdY[k] = y;
    this.cmdR[k] = def.radius;
    return i;
  }

  /** Командири з хвилею (1 + хвиля/2) і поодинці раз на COMMANDER_INTERVAL. */
  private commanderDirector(dt: number): void {
    const d = this.director;
    if (d.time < 0) return; // підготовка
    if (d.wave > this.lastWave) {
      this.lastWave = d.wave;
      const n = Math.min(COMMANDERS_PER_WAVE_MAX, 1 + (d.wave >> 1));
      for (let k = 0; k < n; k++) this.spawnCommander(d.side);
    }
    if ((this.commanderTimer += dt) >= COMMANDER_INTERVAL) {
      this.commanderTimer = 0;
      this.spawnCommander(-1);
    }
  }

  /** Список живих командирів + штамп у сітки cmdNear / cmdAura (до проходу руху). */
  private prepareCommanders(): void {
    const { alive, type, posX, posY, radius } = this.store;
    let n = 0;
    for (let k = 0; k < this.commanderCount; k++) {
      const i = this.cmdSlot[k];
      if (!alive[i] || type[i] !== COMMANDER_TYPE) continue;
      this.cmdSlot[n] = i;
      this.cmdX[n] = posX[i];
      this.cmdY[n] = posY[i];
      this.cmdR[n] = radius[i];
      n++;
    }
    const hadAny = this.commanderCount > 0;
    this.commanderCount = n;
    this.defense.setCommanders(this.cmdSlot, n);
    if (!hadAny) return;
    const near = this.cmdNear;
    const aura = this.cmdAura;
    near.fill(-1);
    aura.fill(0);
    const cs = DENSITY_CELL_SIZE;
    const dw = this.densityW;
    for (let k = 0; k < n; k++) {
      const x = this.cmdX[k];
      const y = this.cmdY[k];
      // Будь-яка клітинка, з якої жук за крок може зачепити коло командира.
      const reach = this.cmdR[k] + MAX_BUG_RADIUS + 4;
      for (let pass = 0; pass < 2; pass++) {
        const R = pass === 0 ? COMMANDER_AURA : reach;
        const x0 = Math.max(0, ((x - R) / cs) | 0);
        const y0 = Math.max(0, ((y - R) / cs) | 0);
        const x1 = Math.min(dw - 1, ((x + R) / cs) | 0);
        const y1 = Math.min(dw - 1, ((y + R) / cs) | 0);
        for (let cy = y0; cy <= y1; cy++) {
          for (let cx = x0; cx <= x1; cx++) {
            // Найближча до командира точка клітинки — в радіусі?
            const qx = Math.max(cx * cs, Math.min(x, (cx + 1) * cs)) - x;
            const qy = Math.max(cy * cs, Math.min(y, (cy + 1) * cs)) - y;
            if (qx * qx + qy * qy > R * R) continue;
            if (pass === 0) aura[cy * dw + cx] = 1;
            else near[cy * dw + cx] = k;
          }
        }
      }
    }
  }

  /** Штамп зброї в грубу сітку агро: кожна клітинка в AGGRO_RADIUS пам'ятає найближчу зброю. */
  private prepareAggro(): void {
    const def = this.defense;
    const { aggroX, aggroY, aggroD } = this;
    if (this.aggroOn) aggroD.fill(Infinity);
    this.aggroOn = false;
    const cs = DENSITY_CELL_SIZE;
    const dw = this.densityW;
    const R = AGGRO_RADIUS;
    for (let b = 0; b < def.bCount; b++) {
      if (!def.bAlive[b] || def.bType[b] > B_TESLA) continue;
      this.aggroOn = true;
      const x = def.bX[b];
      const y = def.bY[b];
      const x0 = Math.max(0, ((x - R) / cs) | 0);
      const y0 = Math.max(0, ((y - R) / cs) | 0);
      const x1 = Math.min(dw - 1, ((x + R) / cs) | 0);
      const y1 = Math.min(dw - 1, ((y + R) / cs) | 0);
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const dx = (cx + 0.5) * cs - x;
          const dy = (cy + 0.5) * cs - y;
          const d2 = dx * dx + dy * dy;
          const c = cy * dw + cx;
          if (d2 > R * R || d2 >= aggroD[c]) continue;
          aggroD[c] = d2;
          aggroX[c] = x;
          aggroY[c] = y;
        }
      }
    }
  }

  /** Ядро бункера зруйновано. */
  get gameOver(): boolean {
    return this.map.coreHp <= 0;
  }

  // --- Будівництво (з UI). Після кожної зміни — новий буфер скель для рендеру і перебудова поля.

  build(type: number, x: number, y: number, angle: number): boolean {
    const ok = this.defense.place(type, x, y, angle) >= 0;
    this.syncDefense();
    return ok;
  }

  buildWall(x1: number, y1: number, x2: number, y2: number): boolean {
    const ok = this.defense.placeWall(x1, y1, x2, y2) >= 0;
    this.syncDefense();
    return ok;
  }

  buildMinefield(x: number, y: number, angle: number): number {
    const n = this.defense.placeMinefield(x, y, angle);
    this.syncDefense();
    return n;
  }

  demolishAt(x: number, y: number): boolean {
    const b = this.defense.buildingAt(x, y);
    this.defense.demolish(b);
    this.syncDefense();
    return b >= 0;
  }

  orbital(x: number, y: number): void {
    this.defense.orbital(x, y);
  }

  private syncDefense(): void {
    if (!this.defense.changed) return;
    this.defense.changed = false;
    this.map.obstacleVersion++;
    if (this.defense.navChanged) {
      this.defense.navChanged = false;
      this.navDirty = true;
      this.navUrgent = true;
    }
  }

  packFx(showZones: boolean, hovered: number, timeSec: number): void {
    this.defense.packRender(this.fxFrame, showZones, hovered, timeSec);
    // Командири: аура й смужка міцності (над жуками).
    const f = this.fxFrame;
    const d = f.instances;
    const { posX, posY, hp, alive, type } = this.store;
    const hpMax = BUG_TYPES[COMMANDER_TYPE].hp;
    for (let k = 0; k < this.commanderCount; k++) {
      const i = this.cmdSlot[k];
      if (!alive[i] || type[i] !== COMMANDER_TYPE) continue;
      if ((f.count + 2) * FX_FLOATS > d.length) break;
      let o = f.count++ * FX_FLOATS;
      d[o] = posX[i];
      d[o + 1] = posY[i];
      d[o + 2] = this.cmdR[k];
      d[o + 3] = hp[i] / hpMax;
      d[o + 4] = COMMANDER_AURA;
      d[o + 5] = FX_COMMANDER;
      d[o + 6] = 0;
      d[o + 7] = 0;
      o = f.count++ * FX_FLOATS;
      d[o] = posX[i];
      d[o + 1] = posY[i] - this.cmdR[k] - 3;
      d[o + 2] = 0;
      d[o + 3] = 0;
      d[o + 4] = 7;
      d[o + 5] = FX_HP_BAR;
      d[o + 6] = Math.max(0, hp[i] / hpMax);
      d[o + 7] = 0;
    }
  }

  step(dt: number): void {
    this.cullExcess();
    if (this.params.autoWaves) {
      this.director.update(dt);
      this.commanderDirector(dt);
    }
    this.spawn(dt);
    this.hash.build(this.store);
    this.accumulateSeparation(dt);
    this.buildDensity();
    this.prepareCommanders();
    this.prepareAggro();
    this.integrate(dt);
    this.defense.step(dt);
    this.applyObstacleDamage();
    this.regenerate(dt);
    this.checkErosion();
    this.syncDefense();
    this.runJobs();
    this.tick++;
  }

  /** Скелі, роз'їдені за крок: зменшуємо, руйнуємо, позначаємо flow field застарілим. */
  private applyObstacleDamage(): void {
    const res = this.obstacles.applyDamage();
    if (!res.changed) return;
    // Будівлі, які жуки догризли до нуля, — прибрати (через Defense: зброя, підтримка стін).
    const obs = this.obstacles;
    for (let k = 0; k < obs.destroyedCount; k++) this.defense.onObstacleDestroyed(obs.destroyedOwners[k]);
    this.map.obstacleVersion++;
    this.rocksDestroyed += res.destroyed;
    if (res.navDirty) this.navDirty = true;
  }

  /** Авторегенерація будівель і ядра бункера. */
  private regenerate(dt: number): void {
    const res = this.obstacles.regenerate(dt);
    if (res & 2) this.navDirty = true;
    // Буфер скель для рендеру перезаливаємо не щокроку, а раз на ~0.5 с регенерації.
    if (res & 1 && (this.regenAcc += dt) >= 0.5) {
      this.regenAcc = 0;
      this.map.obstacleVersion++;
    }
    const map = this.map;
    if ((this.coreSinceHit += dt) >= CORE_REGEN_DELAY && map.coreHp > 0 && map.coreHp < map.coreHpMax) {
      map.coreHp = Math.min(map.coreHpMax, map.coreHp + map.coreHpMax * CORE_REGEN_RATE * dt);
    }
  }

  /** Кратери, що доросли до повного розміру, відкривають прохід → перебудувати flow field. */
  private checkErosion(): void {
    if (this.erosion.completed === 0) return;
    this.erosion.completed = 0;
    this.navDirty = true;
  }

  /**
   * Фонові задачі з бюджетом JOB_BUDGET_MS на крок (див. jobs.ts). Одночасно — одна:
   * перебудова flow field після руйнування має пріоритет над періодичним полем заторів.
   * Після дії гравця перебудова термінова: поточну задачу кидаємо (обидва поля пишуть у задній
   * буфер і підмінюють лише в кінці, тож перервати безпечно) і даємо більший бюджет.
   */
  private runJobs(): void {
    if (this.navUrgent && this.job && !this.jobUrgent) {
      this.job = null;
      this.jobKind = 0;
    } else if (this.navUrgent && this.job) {
      // Термінова перебудова вже йде, але набір стін знову змінився — починаємо заново.
      this.job = null;
    }
    if (!this.job) {
      if (this.navDirty) {
        this.navDirty = false;
        this.jobUrgent = this.navUrgent;
        this.navUrgent = false;
        this.job = this.navRebuildJob();
        this.jobKind = 1;
      } else if (this.params.congestionStrength > 0 && this.tick - this.lastCongestionTick >= CONGESTION_PERIOD_STEPS) {
        this.lastCongestionTick = this.tick;
        this.job = this.congestion.update(this.density, this.densityW, DENSITY_CELL_SIZE, CONGESTION_WEIGHT, JAM_DENSITY);
        this.jobKind = 2;
      }
    }
    if (!this.job) return;
    setJobDeadline(performance.now() + (this.jobUrgent ? JOB_BUDGET_URGENT_MS : JOB_BUDGET_MS));
    const done = this.job.next().done;
    setJobDeadline(Infinity);
    if (done) {
      this.job = null;
      this.jobKind = 0;
      this.jobUrgent = false;
    }
  }

  private *navRebuildJob(): Job {
    const b = this.map.bunker;
    const nav = yield* this.navBuilder.build(this.map.obstacles, this.erosion, b.x, b.y, b.r, NAV_INFLATE);
    // Атомарна підміна: жуки й рендер переходять на нове поле між кроками.
    this.map.nav = nav;
    this.map.coverage = this.navBuilder.coverage;
    this.map.navVersion++;
    yield* this.congestion.rebuild(nav);
  }

  private cullExcess(): void {
    const store = this.store;
    const limit = this.params.hardLimit;
    // Якщо ліміт зменшили — знімаємо зайвих з верхніх слотів. Командирів не чіпаємо.
    const { alive, type } = store;
    for (let i = store.highWater - 1; i >= 0 && store.aliveCount > limit; i--) {
      if (alive[i] && type[i] !== COMMANDER_TYPE) store.free(i);
    }
  }

  private spawn(dt: number): void {
    const store = this.store;
    const p = this.params;
    const director = this.director;
    const rate = p.autoWaves ? director.rate : p.spawnRate;
    this.spawnRateNow = rate;
    const waveSide = p.autoWaves ? director.side : -1;
    const waveBias = director.sideBias;
    this.spawnAcc += rate * dt;
    let n = Math.floor(this.spawnAcc);
    this.spawnAcc -= n;
    const room = p.maxAlive - store.aliveCount;
    if (n > room) n = room;
    if (n <= 0) return;

    // Цілочисельний генератор: його результат не пакується при виклику (див. rng.ts).
    const rng = this.rng;
    const R = RNG_INV30;
    const ws = this.worldSize;
    const { posX, posY, prevX, prevY, velX, velY, radius, maxSpeed, shade, type } = store;
    const { bestDist, stuckTime, detourTime, detourSide, hp, biteReady } = store;
    const lastType = REGULAR_BUG_TYPES - 1; // командир з вагою не з'являється
    for (let s = 0; s < n; s++) {
      const i = store.allocate();
      if (i < 0) break;
      // Під час хвилі більшість жуків іде з її боку.
      const side = waveSide >= 0 && rng() * R < waveBias ? waveSide : (rng() * R * 4) | 0;
      const along = 2 + rng() * R * (ws - 4);
      const depth = 2 + rng() * R * SPAWN_BAND;
      let x: number;
      let y: number;
      if (side === 0) (x = along), (y = depth);
      else if (side === 1) (x = ws - depth), (y = along);
      else if (side === 2) (x = along), (y = ws - depth);
      else (x = depth), (y = along);

      const roll = rng() * R;
      let t = 0;
      while (t < lastType && roll > TYPE_CUMULATIVE[t]) t++;
      const def = BUG_TYPES[t];

      posX[i] = prevX[i] = x;
      posY[i] = prevY[i] = y;
      velX[i] = 0;
      velY[i] = 0;
      radius[i] = def.radius * (1 + (rng() * R * 2 - 1) * BUG_RADIUS_JITTER);
      bestDist[i] = Infinity;
      stuckTime[i] = 0;
      detourTime[i] = 0;
      detourSide[i] = rng() * R < 0.5 ? -1 : 1;
      maxSpeed[i] = def.speed * (1 + (rng() * R * 2 - 1) * BUG_SPEED_JITTER);
      shade[i] = rng() * R;
      type[i] = t;
      hp[i] = def.hp;
      biteReady[i] = 0;
    }
  }

  /**
   * Прохід 1 — розштовхування. Кожна пара жуків обробляється рівно один раз (half-shell):
   * для жука k у клітинці c дивимось лише «вперед» — решту своєї клітинки, східну клітинку
   * та три клітинки рядком нижче. Внесок додається обом жукам з протилежними знаками.
   *
   * Чому так, а не «кожен жук дивиться в 3×3»: перебір кандидатів — найдорожча частина кроку
   * (~38 кандидатів на жука в щільному натовпі, з яких у радіусі лише ~5). Half-shell удвічі
   * зменшує кількість перевірок. До того ж клітинки рядка лежать у відсортованому масиві
   * підряд, тож «уперед» — це лише два неперервні діапазони індексів:
   *   [k+1, start(c+2))           — своя клітинка + схід;
   *   [start(c+w-1), start(c+w+2)) — південний захід, південь, південний схід.
   *
   * Ціна: запис у чужі акумулятори (j), тому цей прохід не можна наївно розпаралелити.
   * Для Worker/GPU-версії природніший «gather»-варіант (кожен жук сам читає 3×3, без записів
   * у сусідів) — він удвічі дорожчий, але без гонок. Див. README.
   *
   * Тут же — укуси. Кусає жук, що (а) у тісняві (тиск попереднього кроку > BITE_PRESSURE),
   * (б) застряг — BITE_STUCK с без наближення до цілі, (в) поруч зі скелею. Жертви — сусіди,
   * менші за нього в BITE_RATIO разів. Так тіснява між каменями сама себе розряджає, а звичайна
   * щільна черга (облога, прорив) — ні.
   */
  private accumulateSeparation(dt: number): void {
    const n = this.hash.count;
    this.accPress.fill(0, 0, n);
    this.accSepX.fill(0, 0, n);
    this.accSepY.fill(0, 0, n);
    this.accCorrX.fill(0, 0, n);
    this.accCorrY.fill(0, 0, n);
    for (let k0 = 0; k0 < n; k0 += HOT_CHUNK) this.separationRange(k0, Math.min(n, k0 + HOT_CHUNK), dt);
  }

  private separationRange(kStart: number, kEnd: number, dt: number): void {
    const { sortedX, sortedY, sortedR, cellStart, sortedIndex } = this.hash;
    const { hp, type, biteReady } = this.store;
    const biteScale = this.params.destruction * dt;
    const biteOn = biteScale > 0;
    const hw = this.hash.w;
    const hMax = this.hash.h - 1;
    const hInv = this.hash.invCell;
    const { accSepX, accSepY, accCorrX, accCorrY, accPress } = this;

    for (let k = kStart; k < kEnd; k++) {
      const x = sortedX[k];
      const y = sortedY[k];
      const r = sortedR[k];
      if (r > BIG_BUG_R) continue; // командир: див. prepareCommanders
      const r2 = r * r;
      const cx = (x * hInv) | 0;
      const cy = (y * hInv) | 0;
      const c = cy * hw + cx;
      // Суми для k тримаємо в регістрах, у масив пишемо раз наприкінці.
      let sx = 0;
      let sy = 0;
      let ox = 0;
      let oy = 0;
      let press = 0;
      let budget = MAX_SCAN;
      const ik = sortedIndex[k];
      const biteK = biteOn && biteReady[ik] ? TYPE_BITE[type[ik]] * biteScale : 0;
      let hpLossK = 0;

      for (let range = 0; range < 2; range++) {
        let j: number;
        let e: number;
        if (range === 0) {
          j = k + 1;
          e = cellStart[cx < hw - 1 ? c + 2 : c + 1];
        } else {
          if (cy >= hMax) break;
          const below = c + hw;
          j = cellStart[cx > 0 ? below - 1 : below];
          e = cellStart[cx < hw - 1 ? below + 2 : below + 1];
        }
        if (e - j > budget) e = j + budget; // обмеження кількості сусідів у патологічно щільних клітинках
        budget -= e - j;

        for (; j < e; j++) {
          let dx = x - sortedX[j];
          let dy = y - sortedY[j];
          const rj = sortedR[j];
          if (rj > BIG_BUG_R) continue;
          const rr = r + rj;
          const reach = rr * SEPARATION_RANGE;
          let d2 = dx * dx + dy * dy;
          if (d2 >= reach * reach) continue;
          if (d2 < 1e-8) {
            // Точний збіг позицій: детерміновано розводимо пару в протилежні боки.
            dx = 0.01;
            dy = 0;
            d2 = 1e-4;
          }
          const d = Math.sqrt(d2);
          const ux = dx / d;
          const uy = dy / d;
          // М'яке розштовхування (steering): лінійно спадає від 1 (впритул) до 0 (на межі reach).
          const w = 1 - d / reach;
          sx += ux * w;
          sy += uy * w;
          accSepX[j] -= ux * w;
          accSepY[j] -= uy * w;
          if (d < rr) {
            // Жорстка корекція перекриття, поділена за «масою» (∝ r²): легший зсувається більше.
            const pen = (rr - d) / (r2 + rj * rj);
            const pk = pen * rj * rj;
            const pj = pen * r2;
            ox += ux * pk;
            oy += uy * pk;
            accCorrX[j] -= ux * pj;
            accCorrY[j] -= uy * pj;
            const ov = (rr - d) / rr;
            press += ov;
            accPress[j] += ov;
            if (biteOn) {
              if (biteK > 0 && r >= rj * BITE_RATIO) {
                hp[sortedIndex[j]] -= biteK;
              } else if (rj >= r * BITE_RATIO) {
                const ij = sortedIndex[j];
                if (biteReady[ij]) hpLossK += TYPE_BITE[type[ij]] * biteScale;
              }
            }
          }
        }
        if (budget <= 0) break;
      }
      accSepX[k] += sx;
      accSepY[k] += sy;
      accCorrX[k] += ox;
      accCorrY[k] += oy;
      accPress[k] += press;
      if (hpLossK > 0) hp[ik] -= hpLossK;
    }
  }

  /**
   * Щільність у грубій сітці + її градієнт (центральні різниці). Градієнт показує, куди
   * натовп густішає; жук ухиляється від нього вбік (див. integrate) — так потоки розтікаються
   * вільнішими сусідніми шляхами, а не збиваються в один «шнур».
   */
  private buildDensity(): void {
    const { cellCount, w: hw, h: hh } = this.hash;
    const dw = this.densityW;
    const ratio = (DENSITY_CELL_SIZE / HASH_CELL_SIZE) | 0;
    const density = this.density;
    density.fill(0);
    for (let hy = 0; hy < hh; hy++) {
      const drow = ((hy / ratio) | 0) * dw;
      const hrow = hy * hw;
      // Внутрішній цикл — блоками по ratio клітинок, без ділення на кожну.
      for (let hx = 0, dx = 0; hx < hw; dx++) {
        let sum = 0;
        const end = hx + ratio < hw ? hx + ratio : hw;
        for (; hx < end; hx++) sum += cellCount[hrow + hx];
        density[drow + dx] += sum;
      }
    }
    const invArea = 1 / (DENSITY_CELL_SIZE * DENSITY_CELL_SIZE);
    for (let c = 0; c < density.length; c++) density[c] *= invArea;

    const gxA = this.densityGradX;
    const gyA = this.densityGradY;
    const inv2h = 1 / (2 * DENSITY_CELL_SIZE);
    for (let y = 0; y < dw; y++) {
      const ym = y > 0 ? y - 1 : 0;
      const yp = y < dw - 1 ? y + 1 : dw - 1;
      for (let x = 0; x < dw; x++) {
        const xm = x > 0 ? x - 1 : 0;
        const xp = x < dw - 1 ? x + 1 : dw - 1;
        gxA[y * dw + x] = (density[y * dw + xp] - density[y * dw + xm]) * inv2h;
        gyA[y * dw + x] = (density[yp * dw + x] - density[ym * dw + x]) * inv2h;
      }
    }
  }

  /**
   * Прохід 2 — рух. Для кожного жука (у порядку spatial hash):
   *   1. напрямок із flow field (білінійно);
   *   2. steering: flow × vmax + розштовхування, з обмеженням прискорення;
   *   3. інтеграція + корекція перекриття + колізії зі скелями, бункером і краями мапи;
   *   4. швидкість = фактичний зсув / dt (як у position-based dynamics).
   * Читаємо знімок sortedX/Y/R і акумулятори, пишемо в posX/posY → незалежно від порядку
   * обходу, тож цей прохід паралелиться без гонок.
   */
  private integrate(dt: number): void {
    const n = this.hash.count;
    for (let k0 = 0; k0 < n; k0 += HOT_CHUNK) this.integrateRange(k0, Math.min(n, k0 + HOT_CHUNK), dt);
  }

  private integrateRange(kStart: number, kEnd: number, dt: number): void {
    const store = this.store;
    const { posX, posY, velX, velY, prevX, prevY, maxSpeed } = store;
    const { bestDist, stuckTime, detourTime, detourSide, hp, biteReady, type } = store;
    const { sortedIndex, sortedX, sortedY, sortedR } = this.hash;
    const { accSepX, accSepY, accCorrX, accCorrY, accPress } = this;

    const nav = this.map.nav;
    const ng = nav.size;
    const ngMax = ng - 1.001;
    const navInv = 1 / nav.cellSize;
    const dirX = nav.dirX;
    const dirY = nav.dirY;
    const navDist = nav.dist;

    const cong = this.congestion;
    const cgs = cong.size;
    const cgMax = cgs - 1.001;
    const cgInv = 1 / cong.cellSize;
    const cgW = cong.blendW;
    const cgX = cong.blendX;
    const cgY = cong.blendY;
    const congStrength = this.params.congestionStrength;

    const dw = this.densityW;
    const dMax = dw - 1.001;
    const dInv = 1 / DENSITY_CELL_SIZE;
    const gradX = this.densityGradX;
    const gradY = this.densityGradY;
    const avoidGain = this.params.avoidStrength * AVOID_GAIN;
    const avoidMax2 = AVOID_MAX * AVOID_MAX;

    const obstacles = this.obstacles;
    const obstacleIo = obstacles.io;
    const obstacleCellStart = obstacles.cellStart;
    // Клітинку гріда перешкод рахуємо в циклі, а не через obstacles.cellOf(x, y): цей цикл завеликий,
    // щоб V8 інлайнив у нього всі виклики, а неінлайнений виклик пакує double-аргументи в HeapNumber.
    const oInv = obstacles.invCell;
    const oMax = obstacles.w - 1;
    const oW = obstacles.w;
    const bunker = this.map.bunker;
    const bx = bunker.x;
    const by = bunker.y;
    const br = bunker.r;
    const ws = this.worldSize;

    const p = this.params;
    const speedMul = p.speedMul;
    const push = p.pushStrength;
    const breakthrough = p.mode === MODE_BREAKTHROUGH;
    const corrodeScale = p.destruction * dt;
    const pendingDamage = obstacles.pendingDamage;
    const erosion = this.erosion;
    const erosionIo = erosion.io;
    const rockCount = obstacles.set.rockCount;
    const attackScale = BUILDING_ATTACK * dt;
    const siegeDps = CORE_SIEGE_DPS * dt;
    let coreDmg = 0;
    let eaten = 0;
    const cmdOn = this.commanderCount > 0;
    const aggroOn = this.aggroOn;
    const gridOn = cmdOn || aggroOn;
    const aggroX = this.aggroX;
    const aggroY = this.aggroY;
    const aggroD = this.aggroD;
    const shade = store.shade;
    const cmdNear = this.cmdNear;
    const cmdAura = this.cmdAura;
    const cmdX = this.cmdX;
    const cmdY = this.cmdY;
    const cmdR = this.cmdR;
    const maxDv = MAX_ACCEL * speedMul * dt;
    const maxDv2 = maxDv * maxDv;
    const invDt = 1 / dt;
    let breaks = 0;

    for (let k = kStart; k < kEnd; k++) {
      const i = sortedIndex[k];
      // З'їдений у тісняві (укуси нараховано в проході пар).
      if (hp[i] <= 0) {
        store.free(i);
        eaten++;
        continue;
      }
      const x = sortedX[k];
      const y = sortedY[k];
      const r = sortedR[k];
      const isCmd = r > BIG_BUG_R;
      // Клітинка грубої сітки (командири): аура і «поруч командир».
      let dcell = -1;
      let buff = 1;
      if (gridOn) {
        let ccx = (x * dInv) | 0;
        let ccy = (y * dInv) | 0;
        ccx = ccx < 0 ? 0 : ccx >= dw ? dw - 1 : ccx;
        ccy = ccy < 0 ? 0 : ccy >= dw ? dw - 1 : ccy;
        dcell = ccy * dw + ccx;
        if (!isCmd && cmdAura[dcell] === 1) buff = COMMANDER_SPEED_BUFF;
      }
      const atkMul = buff > 1 ? COMMANDER_ATTACK_BUFF : 1;

      // --- 1. Flow field, білінійна інтерполяція між центрами 4 клітинок.
      // Заблоковані клітинки мають вектор (0,0), тож вони автоматично «випадають» із суми,
      // а нормалізація нижче відновлює довжину. Тому вектор ніколи не тягне в стіну.
      let gx = x * navInv - 0.5;
      let gy = y * navInv - 0.5;
      if (gx < 0) gx = 0;
      else if (gx > ngMax) gx = ngMax;
      if (gy < 0) gy = 0;
      else if (gy > ngMax) gy = ngMax;
      const ix = gx | 0;
      const iy = gy | 0;
      const tx = gx - ix;
      const ty = gy - iy;
      const c00 = iy * ng + ix;
      const c01 = c00 + ng;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      let fx = dirX[c00] * w00 + dirX[c00 + 1] * w10 + dirX[c01] * w01 + dirX[c01 + 1] * w11;
      let fy = dirY[c00] * w00 + dirY[c00 + 1] * w10 + dirY[c01] * w01 + dirY[c01 + 1] * w11;
      let fl = fx * fx + fy * fy;
      if (fl < 1e-8) {
        fx = bx - x;
        fy = by - y;
        fl = fx * fx + fy * fy + 1e-6;
      }
      fl = 1 / Math.sqrt(fl);
      fx *= fl;
      fy *= fl;
      // Відстань до цілі тут: мінімум по 4 клітинках (жук біля скелі може стояти в «роздутій»
      // заблокованій клітинці, де dist = Infinity).
      let dm = navDist[c00];
      if (navDist[c00 + 1] < dm) dm = navDist[c00 + 1];
      if (navDist[c01] < dm) dm = navDist[c01];
      if (navDist[c01 + 1] < dm) dm = navDist[c01 + 1];
      const dHere = dm;

      // --- 1а. Обхід заторів: де поле заторів радить звернути (див. CongestionField),
      // змішуємо напрямок з його порадою. Вагу й напрямок пораховано заздалегідь на клітинку,
      // тут — лише білінійне читання.
      if (congStrength > 0) {
        let qx = x * cgInv - 0.5;
        let qy = y * cgInv - 0.5;
        if (qx < 0) qx = 0;
        else if (qx > cgMax) qx = cgMax;
        if (qy < 0) qy = 0;
        else if (qy > cgMax) qy = cgMax;
        const kx = qx | 0;
        const ky = qy | 0;
        const ox = qx - kx;
        const oy = qy - ky;
        const e00 = ky * cgs + kx;
        const e01 = e00 + cgs;
        const u00 = (1 - ox) * (1 - oy);
        const u10 = ox * (1 - oy);
        const u01 = (1 - ox) * oy;
        const u11 = ox * oy;
        let bw = cgW[e00] * u00 + cgW[e00 + 1] * u10 + cgW[e01] * u01 + cgW[e01 + 1] * u11;
        if (bw > 1e-3) {
          const bxv = cgX[e00] * u00 + cgX[e00 + 1] * u10 + cgX[e01] * u01 + cgX[e01 + 1] * u11;
          const byv = cgY[e00] * u00 + cgY[e00 + 1] * u10 + cgY[e01] * u01 + cgY[e01 + 1] * u11;
          let sc = congStrength;
          if (bw * sc > 1) sc = 1 / bw;
          fx = fx * (1 - bw * sc) + bxv * sc;
          fy = fy * (1 - bw * sc) + byv * sc;
          const l = 1 / Math.sqrt(fx * fx + fy * fy + 1e-12);
          fx *= l;
          fy *= l;
        }
      }

      // --- 1в. Застрягання біля скель. Жук пам'ятає найменшу досягнуту відстань до цілі;
      // якщо STUCK_TIME секунд немає прогресу і поруч скеля — на DETOUR_TIME відходить убік
      // (і трохи назад) у той бік, звідки до цілі ближче. Це розвантажує «чаші» й тупики.
      if (detourTime[i] > 0) {
        detourTime[i] -= dt;
        const side = detourSide[i];
        let qx = -fy * side - 0.3 * fx;
        let qy = fx * side - 0.3 * fy;
        const l = 1 / Math.sqrt(qx * qx + qy * qy);
        fx = qx * l;
        fy = qy * l;
      } else if (dm !== Infinity && dm > br + 30) {
        if (dm < bestDist[i] - STUCK_PROGRESS) {
          bestDist[i] = dm;
          stuckTime[i] = 0;
        } else if ((stuckTime[i] += dt) > STUCK_TIME) {
          let ocx = (x * oInv) | 0;
          let ocy = (y * oInv) | 0;
          ocx = ocx < 0 ? 0 : ocx > oMax ? oMax : ocx;
          ocy = ocy < 0 ? 0 : ocy > oMax ? oMax : ocy;
          const oc = ocy * oW + ocx;
          if (obstacleCellStart[oc] !== obstacleCellStart[oc + 1]) {
            // Бічні «проби»: у який бік від маршруту до цілі ближче.
            // (Інлайн, а не виклик функції: в облозі застрягають тисячі жуків, і double-аргументи
            // виклику V8 пакував би в HeapNumber — це помітне сміття.)
            const lx = ((x - fy * DETOUR_PROBE) * navInv) | 0;
            const ly = ((y + fx * DETOUR_PROBE) * navInv) | 0;
            const rx = ((x + fy * DETOUR_PROBE) * navInv) | 0;
            const ry = ((y - fx * DETOUR_PROBE) * navInv) | 0;
            const left = lx < 0 || ly < 0 || lx >= ng || ly >= ng ? Infinity : navDist[ly * ng + lx];
            const right = rx < 0 || ry < 0 || rx >= ng || ry >= ng ? Infinity : navDist[ry * ng + rx];
            if (left < right - 1) detourSide[i] = 1;
            else if (right < left - 1) detourSide[i] = -1;
            else detourSide[i] = -detourSide[i]; // нічия — чергуємо боки
            detourTime[i] = DETOUR_TIME;
          }
          stuckTime[i] = 0;
          bestDist[i] = Infinity;
        }
      }

      // --- 1б. Обхід скупчень: ухиляємось від градієнта щільності, але лише ВБІК від маршруту
      // (компоненту вздовж flow прибираємо) — жук не гальмує й не повертає назад, а зміщується
      // на вільніший паралельний шлях.
      if (avoidGain > 0) {
        let ux = x * dInv - 0.5;
        let uy = y * dInv - 0.5;
        if (ux < 0) ux = 0;
        else if (ux > dMax) ux = dMax;
        if (uy < 0) uy = 0;
        else if (uy > dMax) uy = dMax;
        const jx = ux | 0;
        const jy = uy | 0;
        const sx = ux - jx;
        const sy = uy - jy;
        const d00 = jy * dw + jx;
        const d01 = d00 + dw;
        const v00 = (1 - sx) * (1 - sy);
        const v10 = sx * (1 - sy);
        const v01 = (1 - sx) * sy;
        const v11 = sx * sy;
        let ax = -(gradX[d00] * v00 + gradX[d00 + 1] * v10 + gradX[d01] * v01 + gradX[d01 + 1] * v11) * avoidGain;
        let ay = -(gradY[d00] * v00 + gradY[d00 + 1] * v10 + gradY[d01] * v01 + gradY[d01 + 1] * v11) * avoidGain;
        const along = ax * fx + ay * fy;
        ax -= along * fx;
        ay -= along * fy;
        const a2 = ax * ax + ay * ay;
        if (a2 > avoidMax2) {
          const s = AVOID_MAX / Math.sqrt(a2);
          ax *= s;
          ay *= s;
        }
        // Найменша щільність часто — у «тіні» скелі, тобто в кишені біля каменю. Тож ухилення
        // дозволене, лише якщо в той бік не скеля і до цілі звідти не далі, ніж звідси.
        if (a2 > 1e-4) {
          const il = AVOID_PROBE / Math.sqrt(a2);
          const pgx = ((x + ax * il) * navInv) | 0;
          const pgy = ((y + ay * il) * navInv) | 0;
          const probe = pgx < 0 || pgy < 0 || pgx >= ng || pgy >= ng ? Infinity : navDist[pgy * ng + pgx];
          if (probe > dHere + AVOID_PROBE * 0.25) ax = ay = 0;
        }
        fx += ax;
        fy += ay;
        const l = 1 / Math.sqrt(fx * fx + fy * fy);
        fx *= l;
        fy *= l;
      }

      // --- 1г. Агро: частина жуків біля зброї йде прямо на неї (і гризе, щойно торкнеться).
      if (aggroOn && aggroD[dcell] !== Infinity && shade[i] < AGGRO_FRACTION) {
        const tx = aggroX[dcell] - x;
        const ty = aggroY[dcell] - y;
        const tl = tx * tx + ty * ty;
        if (tl > 0.25) {
          const l = 1 / Math.sqrt(tl);
          fx = tx * l;
          fy = ty * l;
        }
      }

      const sepX = accSepX[k];
      const sepY = accSepY[k];
      const corrX = accCorrX[k];
      const corrY = accCorrY[k];

      // --- 2. Steering: бажана швидкість = flow × vmax + розштовхування; Δv обмежене.
      const vmax = maxSpeed[i] * speedMul * buff;
      const pushV = push * vmax;
      // «Затор»: сумарне відносне перекриття з усіма сусідами (скалярний «тиск»).
      // Без цього в глибокому натовпі кожен шар тисне на попередній, перекриття росте лінійно
      // з глибиною (Jacobi за одну ітерацію поводиться як стовп пружин) і натовп колапсує.
      // Векторна сума корекцій тут не годиться: у середині натовпу поштовхи з усіх боків
      // взаємно гасяться, хоча жук стиснутий. Стиснутий жук просто менше «хоче» йти вперед.
      let jam = accPress[k] * (1 / JAM_PRESSURE);
      if (jam > 1) jam = 1;
      const drive = vmax * (1 - JAM_SLOWDOWN * jam);
      let vx = velX[i];
      let vy = velY[i];
      let ax = fx * drive + sepX * pushV - vx;
      let ay = fy * drive + sepY * pushV - vy;
      const a2 = ax * ax + ay * ay;
      if (a2 > maxDv2) {
        const s = maxDv / Math.sqrt(a2);
        ax *= s;
        ay *= s;
      }
      vx += ax;
      vy += ay;

      // --- 3. Інтеграція + корекції.
      let nx = x + vx * dt + corrX * OVERLAP_RELAX;
      let ny = y + vy * dt + corrY * OVERLAP_RELAX;

      // Більшість клітинок без скель — перевіряємо це інлайн, без виклику функції.
      let ocx = (nx * oInv) | 0;
      let ocy = (ny * oInv) | 0;
      ocx = ocx < 0 ? 0 : ocx > oMax ? oMax : ocx;
      ocy = ocy < 0 ? 0 : ocy > oMax ? oMax : ocy;
      const oc = ocy * oW + ocx;
      const nearRock = obstacleCellStart[oc] !== obstacleCellStart[oc + 1];
      // Командир розштовхує натовп: звичайного жука виштовхує з його кола.
      if (dcell >= 0 && !isCmd) {
        const ci = cmdNear[dcell];
        if (ci >= 0) {
          const ex = nx - cmdX[ci];
          const ey = ny - cmdY[ci];
          const rr = cmdR[ci] + r;
          const e2 = ex * ex + ey * ey;
          if (e2 < rr * rr) {
            const s = rr / Math.sqrt(e2 + 1e-12);
            nx = cmdX[ci] + ex * s;
            ny = cmdY[ci] + ey * s;
          }
        }
      }
      // Готовність кусати на наступному кроці: тіснява + застряг + поруч скеля.
      biteReady[i] = nearRock && accPress[k] > BITE_PRESSURE && stuckTime[i] > BITE_STUCK ? 1 : 0;
      if (nearRock) {
        obstacleIo[0] = nx;
        obstacleIo[1] = ny;
        obstacleIo[2] = r;
        obstacles.resolve(oc);
        nx = obstacleIo[0];
        ny = obstacleIo[1];
        const touched = obstacleIo[3];
        if (touched >= rockCount) {
          // Будівлю гравця жук атакує завжди, щойно торкнувся.
          pendingDamage[touched] += TYPE_ATTACK[type[i]] * attackScale * atkMul;
        } else if (touched >= 0 && corrodeScale > 0 && (isCmd || accPress[k] > CORRODE_PRESSURE || stuckTime[i] > 0.5)) {
          // Корозія: жук, що в тісняві чи застряг і вперся в скелю, роз'їдає її саме там, де
          // торкається, — кратер трохи вглиб від точки контакту (erosion.ts).
          const dmg = TYPE_CORRODE[type[i]] * corrodeScale;
          erosionIo[0] = obstacleIo[4] + obstacleIo[6] * CRATER_DEPTH;
          erosionIo[1] = obstacleIo[5] + obstacleIo[7] * CRATER_DEPTH;
          erosionIo[2] = dmg;
          erosion.addDamage();
          pendingDamage[touched] += dmg;
        }
      }

      const bdx = nx - bx;
      const bdy = ny - by;
      const bd2 = bdx * bdx + bdy * bdy;
      if (breakthrough) {
        const killR = br + r + KILL_MARGIN;
        if (bd2 < killR * killR) {
          store.free(i);
          breaks++;
          coreDmg += TYPE_ATTACK[type[i]] * CORE_BREACH_DAMAGE * atkMul;
          continue;
        }
      } else {
        // Облога: бункер — тверде коло; хто торкається — гризе ядро.
        const minR = br + r;
        const touchR = minR + 0.3;
        if (bd2 < touchR * touchR) coreDmg += TYPE_ATTACK[type[i]] * siegeDps * atkMul;
        if (bd2 < minR * minR) {
          const s = minR / Math.sqrt(bd2 + 1e-12);
          nx = bx + bdx * s;
          ny = by + bdy * s;
        }
      }

      if (nx < r) nx = r;
      else if (nx > ws - r) nx = ws - r;
      if (ny < r) ny = r;
      else if (ny > ws - r) ny = ws - r;

      // --- 4. Швидкість із фактичного зсуву: жук, що впирається в натовп чи стіну, втрачає
      // відповідну компоненту швидкості → тиск не накопичується, рух уздовж стіни = ковзання.
      vx = (nx - x) * invDt;
      vy = (ny - y) * invDt;
      const vlim = vmax * 1.5;
      const v2 = vx * vx + vy * vy;
      if (v2 > vlim * vlim) {
        const s = vlim / Math.sqrt(v2);
        vx *= s;
        vy *= s;
      }

      prevX[i] = x;
      prevY[i] = y;
      posX[i] = nx;
      posY[i] = ny;
      velX[i] = vx;
      velY[i] = vy;
    }

    this.breakthroughs += breaks;
    this.eaten += eaten;
    if (coreDmg > 0) {
      this.map.coreHp = Math.max(0, this.map.coreHp - coreDmg);
      this.coreSinceHit = 0;
    }
  }

  /** Пакує живих жуків у щільний буфер для рендеру. Викликається раз на кадр після кроків. */
  packRender(): void {
    const { posX, posY, prevX, prevY, radius, type, shade, alive } = this.store;
    const hw = this.store.highWater;
    const out = this.frame.instances;
    let o = 0;
    for (let i = 0; i < hw; i++) {
      if (alive[i] === 0) continue;
      out[o] = prevX[i];
      out[o + 1] = prevY[i];
      out[o + 2] = posX[i];
      out[o + 3] = posY[i];
      out[o + 4] = radius[i];
      out[o + 5] = type[i] + shade[i] * 0.99;
      o += FLOATS_PER_BUG;
    }
    this.frame.count = o / FLOATS_PER_BUG;
    this.frame.version++;
  }
}
