import { COMMANDER_RADIUS, COMMANDER_TYPE } from '../shared/constants';
import {
  OBSTACLE_CIRCLE,
  OBSTACLE_RECT,
  OBSTACLE_STYLE_CORNER,
  OBSTACLE_STYLE_PAD,
  OBSTACLE_STYLE_WALL,
  type MapData,
} from '../shared/contracts';
import {
  B_CANNON,
  B_CORNER,
  B_FLAMER,
  B_MINE,
  B_MORTAR,
  B_TESLA,
  B_TURRET,
  B_WALL,
  BUILDINGS,
  FX_CORE_HP,
  FX_EXPLOSION,
  FX_FIRE,
  FX_FLAME,
  FX_HEAD,
  FX_HP_BAR,
  FX_LIGHTNING,
  FX_MINE,
  FX_MORTAR,
  FX_ORBITAL_MARK,
  FX_ORBITAL_SHELL,
  FX_SECTOR,
  FX_SHELL,
  FX_SPARK,
  FX_TRACER,
  FX_FLOATS,
  isWeapon,
  type FxFrame,
} from '../shared/defense';
import type { BugStore } from './bugStore';
import { obstacleSignedDistance, type ObstacleField } from './obstacles';
import { mulberry32Int, RNG_INV30 } from './rng';
import type { SpatialHash } from './spatialHash';

// --- Ємності пулів (виділяються один раз).
const MAX_BUILDINGS = 4096;
const MAX_PROJECTILES = 16384;
const MAX_FIRES = 4096;
const MAX_FX = 4096;

// --- Балістика й шкода. Кути — у радіанах, відстані — у метрах (одиницях світу).
const DEG = Math.PI / 180;

const TURRET_RATE = 20; // пострілів/с
const TURRET_MAG = 200;
const TURRET_RELOAD = 0.5;
const TURRET_DMG = 4;
const TURRET_SPREAD = 2.5 * DEG;
const BULLET_SPEED = 650;

const CANNON_RELOAD = 3;
const CANNON_SPEED = 380;
const CANNON_SPREAD = 1.2 * DEG;
const CANNON_AOE = 14;
const CANNON_DMG = 45;

const MORTAR_RELOAD = 2.2;
const MORTAR_T0 = 1.1; // час польоту = T0 + d / V
const MORTAR_V = 420;
const MORTAR_SCATTER = 6; // + 4 % дистанції
const MORTAR_AOE = 16;
const MORTAR_DMG = 30;

// Вогонь не сумується: жук у кількох зонах горить як в одній (burnStep). Ранній варіант зі
// сумуванням (12 крапель/с × 3.5 с, 10/с кожна) створював суцільні вогневі заслони: 12 вогнеметів
// вбивали в 18 разів більше за 12 турелей.
const FLAME_RATE = 6;
const FLAME_SPEED = 120;
const FLAME_SPREAD = 7 * DEG;
const FIRE_RADIUS = 6;
const FIRE_LIFE = 2.5;
const FIRE_DPS = 4.5;

const TESLA_RELOAD = 1;
const TESLA_DMG = 30;
const TESLA_TARGETS = 8;
const TESLA_FALLOFF = 0.72;
const TESLA_JUMP = 18;
/** Розкид точки удару і радіус, у якому блискавка «чіпляється» за жука. Інакше — промах у землю. */
const TESLA_SPREAD = 4;
const TESLA_CATCH = 3.5;

// Міни ставляться полем (MINEFIELD_COUNT за клік) і навмисно помірні: малий радіус, мінімальна
// відстань між мінами. Ранній варіант (18 м / 70 шкоди, без обмеження щільності) дозволяв
// килимом мін тримати всю оборону.
const MINE_FUSE = 1;
const MINE_AOE = 9;
const MINE_DMG = 40;
/** Через скільки секунд спрацьована міна знову зводиться на тому самому місці. */
export const MINE_REARM = 25;
/** Мінімальна відстань між будь-якими двома мінами. */
const MINE_SPACING = 7;
/** Мінне поле: центр + шестикутник на цій відстані. */
export const MINEFIELD_COUNT = 7;
export const MINEFIELD_STEP = 8;
/** Радіус мінного поля (для прев'ю й кроку ряду полів). */
export const MINEFIELD_RADIUS = MINEFIELD_STEP + 2;

const ORBITAL_SHELLS = 10;
const ORBITAL_RADIUS = 40;
const ORBITAL_DELAY = 1.4;
const ORBITAL_STAGGER = 1.2;
const ORBITAL_AOE = 18;
const ORBITAL_DMG = 120;

/** Шкода вибуху спадає від центру до краю до цієї частки. */
const AOE_EDGE = 0.4;
/** Перші метри від стрільця скелі не перекривають (підставка може стояти впритул до скелі). */
const MUZZLE_CLEAR = 6;
const RETARGET = 0.4;
const RETARGET_IDLE = 0.25;
/** Наскільки близько до кута має бути кінець стіни, щоб кут її підтримував. */
export const CORNER_SNAP = 3.2;
const WALL_MIN = 3;
export const WALL_MAX = 120;

// Таблиці на тип будівлі (typed arrays — щоб цикли не лізли в масив об'єктів).
const TURN_RATE = Float32Array.from([220, 60, 90, 200, 360, 0, 0, 0], (v) => v * DEG);
const ALIGN = Float32Array.from([4, 2, 5, 8, 12, 0, 0, 0], (v) => v * DEG);
const RANGE = Float32Array.from(BUILDINGS, (b) => b.range);
const MIN_RANGE = Float32Array.from(BUILDINGS, (b) => b.minRange);
const HALF_ARC = Float32Array.from(BUILDINGS, (b) => b.arc / 2);
const RADIUS = Float32Array.from(BUILDINGS, (b) => b.radius);

// Вибухи: радіус і шкода за видом (таблиці замість double-аргументів, див. `at`).
const X_CANNON = 0;
const X_MORTAR = 1;
const X_MINE = 2;
const X_ORBITAL = 3;
const AOE_R = Float32Array.from([CANNON_AOE, MORTAR_AOE, MINE_AOE, ORBITAL_AOE]);
const AOE_DMG = Float32Array.from([CANNON_DMG, MORTAR_DMG, MINE_DMG, ORBITAL_DMG]);
// Швидкість і розкид прямого вогню за типом будівлі.
const SHOT_SPEED = Float32Array.from([BULLET_SPEED, CANNON_SPEED, 0, FLAME_SPEED, 0]);
const SHOT_SPREAD = Float32Array.from([TURRET_SPREAD, CANNON_SPREAD, 0, FLAME_SPREAD, 0]);

// Види снарядів.
const P_BULLET = 0;
const P_SHELL = 1;
const P_MORTAR = 2;
const P_FLAME = 3;
const P_ORBITAL = 4;

// Види короткоживучих ефектів.
const E_EXPLOSION = 0;
const E_LIGHTNING = 1;
const E_SPARK = 2;
const E_ORBITAL_MARK = 3;

const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

/**
 * Оборона: будівлі гравця, наведення, снаряди, зони вогню, ефекти.
 *
 * Усе — SoA-пули фіксованої ємності, як і жуки: жодних об'єктів на снаряд, жодних алокацій у кроці.
 *
 * Зброя ніколи не завдає шкоди «напряму» конкретному жукові. Вона обирає ціль (жука в робочій
 * зоні), рахує точку прицілювання з упередженням і розкидом і стріляє ТУДИ. Шкоду отримує той,
 * хто реально опинився на шляху снаряда (кулі, фугас) або в зоні ураження (вибух, вогонь,
 * блискавка, що чіпляється за найближчого до точки удару). Тож промахи й «випадкові» жертви —
 * чесні, а не кидок кубика.
 *
 * Пошук цілі не перебирає жуків: він іде грубою сіткою щільності (16×16 м, її вже рахує
 * симуляція), а вже в обраній клітинці бере конкретного жука зі spatial hash. Влучання кулі —
 * DDA-обхід клітинок spatial hash уздовж відрізка, який куля пролетіла за крок.
 */
export class Defense {
  // --- Будівлі
  readonly bType = new Uint8Array(MAX_BUILDINGS);
  readonly bAlive = new Uint8Array(MAX_BUILDINGS);
  readonly bX = new Float32Array(MAX_BUILDINGS);
  readonly bY = new Float32Array(MAX_BUILDINGS);
  /** Напрямок робочої зони (заданий гравцем при будівництві); для стіни — її кут. */
  readonly bAim = new Float32Array(MAX_BUILDINGS);
  /** Поточний кут ствола (обертається в межах зони). */
  readonly bHead = new Float32Array(MAX_BUILDINGS);
  /** Довжина стіни. */
  readonly bLen = new Float32Array(MAX_BUILDINGS);
  readonly bObs = new Int32Array(MAX_BUILDINGS);
  readonly bAmmo = new Float32Array(MAX_BUILDINGS);
  readonly bCool = new Float32Array(MAX_BUILDINGS);
  readonly bReload = new Float32Array(MAX_BUILDINGS);
  readonly bRetarget = new Float32Array(MAX_BUILDINGS);
  readonly bSlot = new Int32Array(MAX_BUILDINGS);
  readonly bFlash = new Float32Array(MAX_BUILDINGS);
  /** Міна: −1 — чекає, ≥0 — секунд до вибуху, −2 — спрацювала й перезаряджається (bReload — скільки лишилось). */
  readonly bFuse = new Float32Array(MAX_BUILDINGS);
  private readonly bFree = new Int32Array(MAX_BUILDINGS);
  private bFreeTop = 0;
  /** Усі живі будівлі мають індекс < bCount. */
  bCount = 0;
  buildingCount = 0;

  // --- Снаряди
  private readonly pKind = new Uint8Array(MAX_PROJECTILES);
  private readonly pAlive = new Uint8Array(MAX_PROJECTILES);
  private readonly pX = new Float32Array(MAX_PROJECTILES);
  private readonly pY = new Float32Array(MAX_PROJECTILES);
  private readonly pPX = new Float32Array(MAX_PROJECTILES);
  private readonly pPY = new Float32Array(MAX_PROJECTILES);
  private readonly pVX = new Float32Array(MAX_PROJECTILES);
  private readonly pVY = new Float32Array(MAX_PROJECTILES);
  private readonly pLife = new Float32Array(MAX_PROJECTILES);
  private readonly pAge = new Float32Array(MAX_PROJECTILES);
  /** Повний час польоту (міномет, орбіта) — для дуги в рендері. */
  private readonly pTotal = new Float32Array(MAX_PROJECTILES);
  private readonly pTravel = new Float32Array(MAX_PROJECTILES);
  private readonly pFree = new Int32Array(MAX_PROJECTILES);
  private pFreeTop = 0;
  private pCount = 0;
  projectileCount = 0;

  // --- Зони вогню
  private readonly fX = new Float32Array(MAX_FIRES);
  private readonly fY = new Float32Array(MAX_FIRES);
  private readonly fAge = new Float32Array(MAX_FIRES);
  private readonly fAlive = new Uint8Array(MAX_FIRES);
  private readonly fFree = new Int32Array(MAX_FIRES);
  private fFreeTop = 0;
  private fCount = 0;
  fireCount = 0;

  // --- Ефекти (лише для рендеру)
  private readonly eKind = new Uint8Array(MAX_FX);
  private readonly eAX = new Float32Array(MAX_FX);
  private readonly eAY = new Float32Array(MAX_FX);
  private readonly eBX = new Float32Array(MAX_FX);
  private readonly eBY = new Float32Array(MAX_FX);
  private readonly eSize = new Float32Array(MAX_FX);
  private readonly eAge = new Float32Array(MAX_FX);
  private readonly eLife = new Float32Array(MAX_FX);
  private eCount = 0;

  /** Вбито зброєю (за мапу); з них командирів. */
  kills = 0;
  commanderKills = 0;
  /** true — набір будівель-перешкод змінився (треба оновити буфер рендеру). */
  changed = false;
  /** true — змінились стіни чи кути, тобто flow field (підставки зброї й міни в нього не входять). */
  navChanged = false;

  /**
   * Вхід/вихід «гарячих» методів (влучання, вибух, пошук найближчого) — замість double-аргументів,
   * які V8 пакував би в HeapNumber при неінлайненому виклику (див. ObstacleField.io).
   */
  private readonly io = new Float64Array(8);
  /** Аргументи вибуху, ефекту, підпалу, прямої видимості — з тієї ж причини, що й io. */
  private readonly at = new Float64Array(8);
  /** Ланцюг блискавки: уражені жуки (щоб не бити одного двічі). */
  private readonly chain = new Int32Array(TESLA_TARGETS);
  /** Крок, у якому жук уже отримав шкоду від вогню (щоб зони не сумувались). */
  private readonly burnStep: Int32Array;
  private stepNo = 0;
  private chainLen = 0;
  private readonly rng = mulberry32Int(0x7e57);

  private map!: MapData;
  private obstacles!: ObstacleField;
  /** Живі командири (слоти) — ціль із пріоритетом. Масив і лічильник веде Simulation. */
  private cmdSlots: Int32Array = new Int32Array(0);
  private cmdCount = 0;

  setCommanders(slots: Int32Array, count: number): void {
    this.cmdSlots = slots;
    this.cmdCount = count;
  }

  constructor(
    private readonly store: BugStore,
    private readonly hash: SpatialHash,
    private readonly density: Float32Array,
    private readonly densityW: number,
    private readonly densityCell: number,
  ) {
    this.burnStep = new Int32Array(store.capacity).fill(-1);
    this.reset();
  }

  setMap(map: MapData, obstacles: ObstacleField): void {
    this.map = map;
    this.obstacles = obstacles;
    this.reset();
  }

  /** Прибирає все: будівлі, снаряди, вогонь, ефекти. */
  reset(): void {
    this.bAlive.fill(0);
    this.bFreeTop = 0;
    for (let i = MAX_BUILDINGS - 1; i >= 0; i--) this.bFree[this.bFreeTop++] = i;
    this.bCount = 0;
    this.buildingCount = 0;
    this.clearProjectiles();
    this.kills = 0;
  }

  /** Снаряди, вогонь, ефекти — геть (будівлі лишаються). */
  clearProjectiles(): void {
    this.pAlive.fill(0);
    this.pFreeTop = 0;
    for (let i = MAX_PROJECTILES - 1; i >= 0; i--) this.pFree[this.pFreeTop++] = i;
    this.pCount = 0;
    this.projectileCount = 0;
    this.fAlive.fill(0);
    this.fFreeTop = 0;
    for (let i = MAX_FIRES - 1; i >= 0; i--) this.fFree[this.fFreeTop++] = i;
    this.fCount = 0;
    this.fireCount = 0;
    this.eCount = 0;
    for (let b = 0; b < this.bCount; b++) {
      this.bSlot[b] = -1;
      this.bFuse[b] = -1;
    }
  }

  private rand(): number {
    return this.rng() * RNG_INV30;
  }

  // =====================================================================================
  // Будівництво
  // =====================================================================================

  /**
   * Чи можна поставити будівлю `type` у (x, y). Для стіни — відрізок (x, y)–(x2, y2).
   * Не гарячий шлях (викликається з UI для прев'ю), тож простий перебір перешкод.
   */
  canPlace(type: number, x: number, y: number, x2 = x, y2 = y): boolean {
    const ws = this.map.worldSize;
    const r = RADIUS[type];
    const b = this.map.bunker;
    if (type === B_WALL) {
      const len = Math.hypot(x2 - x, y2 - y);
      if (len < WALL_MIN || len > WALL_MAX + 0.01) return false;
      const n = Math.max(2, Math.ceil(len / 1.5));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const px = x + (x2 - x) * t;
        const py = y + (y2 - y) * t;
        // Біля кінців стіна може заходити в кут чи іншу стіну (з'єднання).
        const nearEnd = Math.min(t, 1 - t) * len < CORNER_SNAP + RADIUS[B_CORNER] + RADIUS[B_WALL] + 1;
        if (!this.pointFree(px, py, r, nearEnd, ws, b)) return false;
      }
      return true;
    }
    if (!this.pointFree(x, y, r, false, ws, b)) return false;
    // Міни — не густіше за MINE_SPACING, а будівлі — не на міни.
    const minD = type === B_MINE ? MINE_SPACING : r + RADIUS[B_MINE] + 0.5;
    for (let i = 0; i < this.bCount; i++) {
      if (!this.bAlive[i] || this.bType[i] !== B_MINE) continue;
      if (Math.hypot(this.bX[i] - x, this.bY[i] - y) < minD - 1e-3) return false;
    }
    return true;
  }

  private pointFree(x: number, y: number, r: number, joint: boolean, ws: number, b: { x: number; y: number; r: number }): boolean {
    if (x < r + 2 || y < r + 2 || x > ws - r - 2 || y > ws - r - 2) return false;
    if (Math.hypot(x - b.x, y - b.y) < b.r + r + 3) return false;
    const set = this.map.obstacles;
    for (let i = 0; i < set.count; i++) {
      if (!set.alive[i]) continue;
      if (joint && i >= set.rockCount) {
        const owner = set.owner[i];
        const t = owner >= 0 ? this.bType[owner] : -1;
        if (t === B_WALL || t === B_CORNER) continue;
      }
      if (obstacleSignedDistance(set, i, x, y) < r + 0.3) return false;
    }
    return true;
  }

  /**
   * Мінне поле: MINEFIELD_COUNT мін (центр + шестикутник), повернуте на angle. Ставить ті міни,
   * для яких є місце; повертає їх кількість.
   */
  placeMinefield(x: number, y: number, angle: number): number {
    let n = 0;
    for (let k = 0; k < MINEFIELD_COUNT; k++) {
      const a = angle + ((k - 1) * Math.PI) / 3;
      const r = k === 0 ? 0 : MINEFIELD_STEP;
      if (this.place(B_MINE, x + Math.cos(a) * r, y + Math.sin(a) * r, 0) >= 0) n++;
    }
    return n;
  }

  /** Позиція k-ї міни поля (для прев'ю) — у snapX/snapY. */
  minefieldSpot(x: number, y: number, angle: number, k: number): void {
    const a = angle + ((k - 1) * Math.PI) / 3;
    const r = k === 0 ? 0 : MINEFIELD_STEP;
    this.snapX = x + Math.cos(a) * r;
    this.snapY = y + Math.sin(a) * r;
  }

  /** Ставить будівлю (не стіну). angle — напрямок робочої зони. Повертає індекс або −1. */
  place(type: number, x: number, y: number, angle: number): number {
    if (type === B_WALL || !this.canPlace(type, x, y)) return -1;
    const b = this.allocBuilding(type, x, y, angle);
    if (b < 0) return -1;
    const obs = this.obstacles;
    if (type === B_CORNER) {
      const r = RADIUS[type];
      this.bObs[b] = obs.addBuilding(OBSTACLE_RECT, OBSTACLE_STYLE_CORNER, x, y, r, r, angle, BUILDINGS[type].hp, b, true);
    } else if (isWeapon(type)) {
      // Підставка зброї мала — у flow field її не пишемо (тоді будівництво не чекає перебудови поля).
      this.bObs[b] = obs.addBuilding(OBSTACLE_CIRCLE, OBSTACLE_STYLE_PAD, x, y, RADIUS[type], 0, 0, BUILDINGS[type].hp, b, false);
    }
    if (this.bObs[b] >= 0 || type === B_MINE) {
      this.afterChange(type);
      return b;
    }
    this.freeBuilding(b);
    return -1;
  }

  placeWall(x1: number, y1: number, x2: number, y2: number): number {
    if (!this.canPlace(B_WALL, x1, y1, x2, y2)) return -1;
    const len = Math.hypot(x2 - x1, y2 - y1);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const b = this.allocBuilding(B_WALL, (x1 + x2) / 2, (y1 + y2) / 2, angle);
    if (b < 0) return -1;
    this.bLen[b] = len;
    const hp = BUILDINGS[B_WALL].hp * len;
    this.bObs[b] = this.obstacles.addBuilding(
      OBSTACLE_RECT, OBSTACLE_STYLE_WALL, this.bX[b], this.bY[b], len / 2, RADIUS[B_WALL], angle, hp, b, true,
    );
    if (this.bObs[b] < 0) {
      this.freeBuilding(b);
      return -1;
    }
    this.afterChange(B_WALL);
    return b;
  }

  /** Кінці стін «прилипають» до найближчого кута або кінця іншої стіни. Результат — у snapX/snapY. */
  snapX = 0;
  snapY = 0;
  snapWallEnd(x: number, y: number): boolean {
    let best = 6;
    this.snapX = x;
    this.snapY = y;
    for (let i = 0; i < this.bCount; i++) {
      if (!this.bAlive[i]) continue;
      const t = this.bType[i];
      if (t === B_CORNER) {
        const d = Math.hypot(this.bX[i] - x, this.bY[i] - y);
        if (d < best) {
          best = d;
          this.snapX = this.bX[i];
          this.snapY = this.bY[i];
        }
      } else if (t === B_WALL) {
        const hx = Math.cos(this.bAim[i]) * this.bLen[i] * 0.5;
        const hy = Math.sin(this.bAim[i]) * this.bLen[i] * 0.5;
        for (let s = -1; s <= 1; s += 2) {
          const ex = this.bX[i] + hx * s;
          const ey = this.bY[i] + hy * s;
          const d = Math.hypot(ex - x, ey - y);
          if (d < best) {
            best = d;
            this.snapX = ex;
            this.snapY = ey;
          }
        }
      }
    }
    return best < 6;
  }

  /** Будівля під точкою (для знесення й підсвітки зони під курсором — щокадру) або −1. */
  buildingAt(x: number, y: number): number {
    let best = -1;
    let bestD = 2.5;
    for (let i = 0; i < this.bCount; i++) {
      if (!this.bAlive[i]) continue;
      let d: number;
      if (this.bType[i] === B_WALL) {
        const c = Math.cos(this.bAim[i]);
        const s = Math.sin(this.bAim[i]);
        const dx = x - this.bX[i];
        const dy = y - this.bY[i];
        const along = Math.max(-this.bLen[i] / 2, Math.min(this.bLen[i] / 2, dx * c + dy * s));
        const ex = dx - c * along;
        const ey = dy - s * along;
        d = Math.sqrt(ex * ex + ey * ey) - RADIUS[B_WALL];
      } else {
        const ex = x - this.bX[i];
        const ey = y - this.bY[i];
        d = Math.sqrt(ex * ex + ey * ey) - RADIUS[this.bType[i]];
      }
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  demolish(b: number): void {
    if (b < 0 || !this.bAlive[b]) return;
    const type = this.bType[b];
    if (this.bObs[b] >= 0) this.obstacles.removeBuilding(this.bObs[b]);
    this.freeBuilding(b);
    this.afterChange(type);
  }

  /** Будівлю зруйнували жуки (її перешкода дійшла до 0 міцності). */
  onObstacleDestroyed(owner: number): void {
    if (owner < 0 || !this.bAlive[owner]) return;
    const at = this.at;
    const R = Math.max(6, RADIUS[this.bType[owner]] * 2.5);
    at[0] = at[2] = this.bX[owner];
    at[1] = at[3] = this.bY[owner];
    at[4] = R;
    at[5] = 0.25 + R * 0.025;
    this.effect(E_EXPLOSION);
    this.demolish(owner);
  }

  /** Орбітальний удар: ORBITAL_SHELLS снарядів неприцільно падають у коло навколо точки. */
  orbital(x: number, y: number): void {
    for (let k = 0; k < ORBITAL_SHELLS; k++) {
      const p = this.allocProjectile(P_ORBITAL);
      if (p < 0) break;
      const a = this.rand() * Math.PI * 2;
      const d = Math.sqrt(this.rand()) * ORBITAL_RADIUS;
      this.pX[p] = this.pPX[p] = x + Math.cos(a) * d;
      this.pY[p] = this.pPY[p] = y + Math.sin(a) * d;
      const delay = ORBITAL_DELAY + this.rand() * ORBITAL_STAGGER;
      this.pLife[p] = delay;
      this.pTotal[p] = delay;
    }
    const at = this.at;
    at[0] = at[2] = x;
    at[1] = at[3] = y;
    at[4] = ORBITAL_RADIUS;
    at[5] = ORBITAL_DELAY + ORBITAL_STAGGER;
    this.effect(E_ORBITAL_MARK);
  }

  private allocBuilding(type: number, x: number, y: number, angle: number): number {
    if (this.bFreeTop === 0) return -1;
    const b = this.bFree[--this.bFreeTop];
    if (b >= this.bCount) this.bCount = b + 1;
    this.bAlive[b] = 1;
    this.bType[b] = type;
    this.bX[b] = x;
    this.bY[b] = y;
    this.bAim[b] = angle;
    this.bHead[b] = angle;
    this.bLen[b] = 0;
    this.bObs[b] = -1;
    this.bAmmo[b] = TURRET_MAG;
    this.bCool[b] = 0;
    this.bReload[b] = 0;
    this.bRetarget[b] = 0;
    this.bSlot[b] = -1;
    this.bFlash[b] = 0;
    this.bFuse[b] = -1;
    this.buildingCount++;
    return b;
  }

  private freeBuilding(b: number): void {
    this.bAlive[b] = 0;
    this.bObs[b] = -1;
    this.bFree[this.bFreeTop++] = b;
    this.buildingCount--;
    while (this.bCount > 0 && !this.bAlive[this.bCount - 1]) this.bCount--;
  }

  private afterChange(type: number): void {
    if (type === B_MINE) return; // міна — не перешкода
    this.obstacles.rebuildGrid();
    if (type === B_WALL || type === B_CORNER) {
      this.updateSupport();
      this.navChanged = true;
    }
    this.changed = true;
  }

  /**
   * Підтримка стін кутами: кінець стіни ближче за CORNER_SNAP до центру кута — підтриманий.
   * Обидва кінці — стіна втричі міцніша (шкода ×1/3), один — ×1/1.35.
   */
  private updateSupport(): void {
    const obs = this.obstacles;
    const set = this.map.obstacles;
    for (let w = 0; w < this.bCount; w++) {
      if (!this.bAlive[w] || this.bType[w] !== B_WALL) continue;
      const hx = Math.cos(this.bAim[w]) * this.bLen[w] * 0.5;
      const hy = Math.sin(this.bAim[w]) * this.bLen[w] * 0.5;
      let ends = 0;
      for (let s = -1; s <= 1; s += 2) {
        const ex = this.bX[w] + hx * s;
        const ey = this.bY[w] + hy * s;
        for (let c = 0; c < this.bCount; c++) {
          if (!this.bAlive[c] || this.bType[c] !== B_CORNER) continue;
          if (Math.hypot(this.bX[c] - ex, this.bY[c] - ey) <= CORNER_SNAP) {
            ends++;
            break;
          }
        }
      }
      const o = this.bObs[w];
      obs.armor[o] = ends === 2 ? 1 / 3 : ends === 1 ? 1 / 1.35 : 1;
      set.style[o] = OBSTACLE_STYLE_WALL + ends;
      obs.updateNavCost(o);
    }
  }

  // =====================================================================================
  // Крок
  // =====================================================================================

  step(dt: number): void {
    for (let b = 0; b < this.bCount; b++) {
      if (!this.bAlive[b]) continue;
      const t = this.bType[b];
      if (t === B_MINE) this.updateMine(b, dt);
      else if (t <= B_TESLA) this.updateWeapon(b, dt);
    }
    this.updateProjectiles(dt);
    this.updateFires(dt);
    this.updateEffects(dt);
  }

  private updateWeapon(b: number, dt: number): void {
    const type = this.bType[b];
    const { posX, posY, alive } = this.store;
    this.bFlash[b] -= dt;
    if (this.bReload[b] > 0) {
      this.bReload[b] -= dt;
      if (this.bReload[b] <= 0) this.bAmmo[b] = TURRET_MAG;
    }
    this.bCool[b] -= dt;

    // Ціль: тримаємо, доки вона жива й у зоні; періодично переоцінюємо (ближча / щільніша).
    let slot = this.bSlot[b];
    if (slot >= 0 && (!alive[slot] || !this.inZone(b, posX[slot], posY[slot]))) slot = this.bSlot[b] = -1;
    this.bRetarget[b] -= dt;
    if (this.bRetarget[b] <= 0) {
      slot = this.bSlot[b] = this.acquire(b);
      this.bRetarget[b] = slot >= 0 ? RETARGET : RETARGET_IDLE;
    }
    if (slot < 0) {
      if (this.bCool[b] < 0) this.bCool[b] = 0;
      return;
    }

    // Поворот ствола до цілі в межах робочої зони.
    const x = this.bX[b];
    const y = this.bY[b];
    const tx = posX[slot];
    const ty = posY[slot];
    const bearing = Math.atan2(ty - y, tx - x);
    let head = this.bHead[b];
    let diff = wrapAngle(bearing - head);
    const turn = TURN_RATE[type] * dt;
    head += diff > turn ? turn : diff < -turn ? -turn : diff;
    const half = HALF_ARC[type];
    const off = wrapAngle(head - this.bAim[b]);
    if (off > half) head = this.bAim[b] + half;
    else if (off < -half) head = this.bAim[b] - half;
    this.bHead[b] = head;
    diff = wrapAngle(bearing - head);
    if (diff > ALIGN[type] || diff < -ALIGN[type]) {
      if (this.bCool[b] < 0) this.bCool[b] = 0;
      return;
    }

    let guard = 0;
    while (this.bCool[b] <= 0 && guard++ < 4) {
      if (type === B_TURRET) {
        if (this.bReload[b] > 0) break;
        this.fireDirect(b, slot, P_BULLET);
        this.bCool[b] += 1 / TURRET_RATE;
        if (--this.bAmmo[b] <= 0) this.bReload[b] = TURRET_RELOAD;
      } else if (type === B_CANNON) {
        this.fireDirect(b, slot, P_SHELL);
        this.bCool[b] += CANNON_RELOAD;
      } else if (type === B_MORTAR) {
        this.fireMortar(b, slot);
        this.bCool[b] += MORTAR_RELOAD;
      } else if (type === B_FLAMER) {
        this.fireDirect(b, slot, P_FLAME);
        this.bCool[b] += 1 / FLAME_RATE;
      } else {
        this.fireTesla(b, slot);
        this.bCool[b] += TESLA_RELOAD;
      }
      this.bFlash[b] = 0.07;
    }
  }

  private inZone(b: number, px: number, py: number): boolean {
    const type = this.bType[b];
    const dx = px - this.bX[b];
    const dy = py - this.bY[b];
    const d2 = dx * dx + dy * dy;
    const r = RANGE[type];
    const m = MIN_RANGE[type];
    if (d2 > r * r || d2 < m * m) return false;
    const off = wrapAngle(Math.atan2(dy, dx) - this.bAim[b]);
    return off <= HALF_ARC[type] && off >= -HALF_ARC[type];
  }

  /**
   * Пошук цілі по сітці щільності. Турель, вогнемет, блискавка — найближча клітинка з жуками;
   * гармата й міномет — найщільніша (більше жертв на вибух). Прямий вогонь потребує прямої
   * видимості (скелі закривають, стіни — ні); міномет стріляє навісом через усе.
   * Повертає слот конкретного жука в обраній клітинці або −1.
   */
  private acquire(b: number): number {
    const type = this.bType[b];
    const densest = type === B_CANNON || type === B_MORTAR;
    const needLos = type !== B_MORTAR;
    const x = this.bX[b];
    const y = this.bY[b];
    // Пріоритет — командир у зоні (найближчий). Без цього натовп завжди «ближчий» і закриває його.
    {
      const { posX, posY, alive, type: btype } = this.store;
      let best = -1;
      let bestD = Infinity;
      for (let k = 0; k < this.cmdCount; k++) {
        const i = this.cmdSlots[k];
        if (!alive[i] || btype[i] !== COMMANDER_TYPE || !this.inZone(b, posX[i], posY[i])) continue;
        const dx = posX[i] - x;
        const dy = posY[i] - y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= bestD) continue;
        if (needLos) {
          const at = this.at;
          at[0] = x;
          at[1] = y;
          at[2] = posX[i];
          at[3] = posY[i];
          if (!this.losClear()) continue;
        }
        bestD = d2;
        best = i;
      }
      if (best >= 0) return best;
    }
    const range = RANGE[type];
    const minR = MIN_RANGE[type];
    const aim = this.bAim[b];
    const ax = Math.cos(aim);
    const ay = Math.sin(aim);
    const cosHalf = Math.cos(HALF_ARC[type]);
    const cs = this.densityCell;
    const dw = this.densityW;
    const density = this.density;
    // Клітинка 16 м: її центр може лежати поза зоною, хоча край — у ній. Допуск — пів діагоналі.
    const slack = cs * 0.75;
    const x0 = Math.max(0, Math.floor((x - range) / cs));
    const y0 = Math.max(0, Math.floor((y - range) / cs));
    const x1 = Math.min(dw - 1, Math.floor((x + range) / cs));
    const y1 = Math.min(dw - 1, Math.floor((y + range) / cs));
    const rMax = range + slack;
    const rMin = minR > slack ? minR - slack : 0;
    let best = Infinity;
    let bestC = -1;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cy * dw + cx;
        const dv = density[c];
        if (dv <= 0) continue;
        const dx = (cx + 0.5) * cs - x;
        const dy = (cy + 0.5) * cs - y;
        const d2 = dx * dx + dy * dy;
        if (d2 > rMax * rMax || d2 < rMin * rMin) continue;
        const d = Math.sqrt(d2);
        if (d > slack && dx * ax + dy * ay < cosHalf * d - slack) continue;
        const score = densest ? d * 0.002 - dv * 100 : d;
        if (score >= best) continue;
        if (needLos && d > MUZZLE_CLEAR + 4) {
          const at = this.at;
          at[0] = x;
          at[1] = y;
          at[2] = x + dx;
          at[3] = y + dy;
          if (!this.losClear()) continue;
        }
        best = score;
        bestC = c;
      }
    }
    if (bestC < 0) return -1;
    return this.bugInCell(b, bestC);
  }

  /** Найближчий до будівлі живий жук у клітинці щільності `dc`, що лежить у робочій зоні. */
  private bugInCell(b: number, dc: number): number {
    const hash = this.hash;
    const ratio = (this.densityCell / hash.cellSize) | 0;
    const dw = this.densityW;
    const hx0 = (dc % dw) * ratio;
    const hy0 = ((dc / dw) | 0) * ratio;
    const { cellStart, sortedIndex } = hash;
    const { posX, posY, alive } = this.store;
    const x = this.bX[b];
    const y = this.bY[b];
    let best = -1;
    let bestD = Infinity;
    for (let hy = hy0; hy < hy0 + ratio && hy < hash.h; hy++) {
      for (let hx = hx0; hx < hx0 + ratio && hx < hash.w; hx++) {
        const c = hy * hash.w + hx;
        for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
          const i = sortedIndex[k];
          if (!alive[i]) continue;
          const dx = posX[i] - x;
          const dy = posY[i] - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD && this.inZone(b, posX[i], posY[i])) {
            bestD = d2;
            best = i;
          }
        }
      }
    }
    return best;
  }

  /** Пряма видимість at[0..1] → at[2..3] по nav-гріду: перекривають лише скелі (blocked = 1), не будівлі. */
  private losClear(): boolean {
    const at = this.at;
    const x0 = at[0];
    const y0 = at[1];
    const x1 = at[2];
    const y1 = at[3];
    const nav = this.map.nav;
    const inv = 1 / nav.cellSize;
    const n = nav.size;
    const blocked = nav.blocked;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    const end = len - 3;
    for (let s = MUZZLE_CLEAR; s < end; s += 2) {
      const gx = ((x0 + (dx * s) / len) * inv) | 0;
      const gy = ((y0 + (dy * s) / len) * inv) | 0;
      if (gx < 0 || gy < 0 || gx >= n || gy >= n) return false;
      if (blocked[gy * n + gx] === 1) return false;
    }
    return true;
  }

  /** Прямий постріл (куля, фугас, вогняна крапля) в точку з упередженням і розкидом. */
  private fireDirect(b: number, slot: number, kind: number): void {
    const p = this.allocProjectile(kind);
    if (p < 0) return;
    const { posX, posY, velX, velY } = this.store;
    const type = this.bType[b];
    const speed = SHOT_SPEED[type];
    const spread = SHOT_SPREAD[type];
    const x = this.bX[b];
    const y = this.bY[b];
    let tx = posX[slot];
    let ty = posY[slot];
    const flight = Math.sqrt((tx - x) * (tx - x) + (ty - y) * (ty - y)) / speed;
    tx += velX[slot] * flight;
    ty += velY[slot] * flight;
    const dx = tx - x;
    const dy = ty - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const ang = Math.atan2(dy, dx) + (this.rand() * 2 - 1) * spread;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const muzzle = RADIUS[type] * 1.6;
    this.pX[p] = this.pPX[p] = x + c * muzzle;
    this.pY[p] = this.pPY[p] = y + s * muzzle;
    this.pVX[p] = c * speed;
    this.pVY[p] = s * speed;
    this.pTravel[p] = muzzle;
    if (kind === P_BULLET) {
      this.pLife[p] = RANGE[type] / speed; // куля летить на всю дальність: промах може влучити далі
    } else if (kind === P_SHELL) {
      this.pLife[p] = Math.max(0.05, dist - muzzle) / speed; // фугас рветься в точці прицілу
    } else {
      // Крапля вогню падає трохи ближче/далі цілі і там розгорається.
      const d = Math.min(RANGE[type], Math.max(8, dist + (this.rand() * 16 - 6)));
      this.pLife[p] = Math.max(0.05, d - muzzle) / speed;
    }
    this.pTotal[p] = this.pLife[p];
  }

  private fireMortar(b: number, slot: number): void {
    const p = this.allocProjectile(P_MORTAR);
    if (p < 0) return;
    const { posX, posY, velX, velY } = this.store;
    const x = this.bX[b];
    const y = this.bY[b];
    const ox = posX[slot] - x;
    const oy = posY[slot] - y;
    const d0 = Math.sqrt(ox * ox + oy * oy);
    const T = MORTAR_T0 + d0 / MORTAR_V;
    const scatter = (MORTAR_SCATTER + d0 * 0.04) * Math.sqrt(this.rand());
    const sa = this.rand() * Math.PI * 2;
    const tx = posX[slot] + velX[slot] * T + Math.cos(sa) * scatter;
    const ty = posY[slot] + velY[slot] * T + Math.sin(sa) * scatter;
    this.pX[p] = this.pPX[p] = x;
    this.pY[p] = this.pPY[p] = y;
    this.pVX[p] = (tx - x) / T;
    this.pVY[p] = (ty - y) / T;
    this.pLife[p] = T;
    this.pTotal[p] = T;
  }

  /**
   * Блискавка б'є в точку поруч із ціллю. Якщо там нікого (у межах TESLA_CATCH) — розряд у землю.
   * Інакше стрибає до найближчого ще не враженого жука в радіусі TESLA_JUMP, щоразу слабша.
   */
  private fireTesla(b: number, slot: number): void {
    const { posX, posY, hp, alive } = this.store;
    const io = this.io;
    const a = this.rand() * Math.PI * 2;
    const r = Math.sqrt(this.rand()) * TESLA_SPREAD;
    const sx = this.bX[b] + Math.cos(this.bHead[b]) * RADIUS[B_TESLA];
    const sy = this.bY[b] + Math.sin(this.bHead[b]) * RADIUS[B_TESLA];
    io[0] = posX[slot] + Math.cos(a) * r;
    io[1] = posY[slot] + Math.sin(a) * r;
    io[2] = TESLA_CATCH;
    this.chainLen = 0;
    let cur = this.nearestBug();
    if (cur < 0) {
      const at = this.at;
      at[0] = sx;
      at[1] = sy;
      at[2] = io[0];
      at[3] = io[1];
      at[4] = 0.5;
      at[5] = 0.18;
      this.effect(E_LIGHTNING);
      at[0] = io[0];
      at[1] = io[1];
      at[4] = 3;
      at[5] = 0.25;
      this.effect(E_SPARK);
      return;
    }
    let px = sx;
    let py = sy;
    let dmg = TESLA_DMG;
    while (cur >= 0) {
      const cx = posX[cur];
      const cy = posY[cur];
      const at = this.at;
      at[0] = px;
      at[1] = py;
      at[2] = cx;
      at[3] = cy;
      at[4] = this.chainLen === 0 ? 0.6 : 0.45;
      at[5] = 0.2;
      this.effect(E_LIGHTNING);
      this.chain[this.chainLen++] = cur;
      if (alive[cur]) {
        hp[cur] -= dmg;
        if (hp[cur] <= 0) this.killBug(cur);
      }
      if (this.chainLen >= TESLA_TARGETS) break;
      dmg *= TESLA_FALLOFF;
      px = cx;
      py = cy;
      io[0] = cx;
      io[1] = cy;
      io[2] = TESLA_JUMP;
      cur = this.nearestBug();
    }
  }

  /** Найближчий живий жук до io[0..1] у радіусі io[2], не з ланцюга. */
  private nearestBug(): number {
    const io = this.io;
    const x = io[0];
    const y = io[1];
    const R = io[2];
    const hash = this.hash;
    const inv = hash.invCell;
    const w = hash.w;
    const { cellStart, sortedIndex } = hash;
    const { posX, posY, alive } = this.store;
    const chain = this.chain;
    const cl = this.chainLen;
    const x0 = Math.max(0, ((x - R) * inv) | 0);
    const y0 = Math.max(0, ((y - R) * inv) | 0);
    const x1 = Math.min(w - 1, ((x + R) * inv) | 0);
    const y1 = Math.min(hash.h - 1, ((y + R) * inv) | 0);
    let best = -1;
    let bestD = R * R;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cy * w + cx;
        for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
          const i = sortedIndex[k];
          if (!alive[i]) continue;
          const dx = posX[i] - x;
          const dy = posY[i] - y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= bestD) continue;
          let used = false;
          for (let j = 0; j < cl; j++) if (chain[j] === i) used = true;
          if (used) continue;
          bestD = d2;
          best = i;
        }
      }
    }
    return best;
  }

  /**
   * Міна: чекає → ворог поруч → вибух через MINE_FUSE → «спрацьована» MINE_REARM секунд →
   * знову зведена на тому самому місці. Мінне поле відновлюється саме; прибрати — лише знести.
   */
  private updateMine(b: number, dt: number): void {
    const fuse = this.bFuse[b];
    if (fuse === -2) {
      if ((this.bReload[b] -= dt) <= 0) this.bFuse[b] = -1;
      return;
    }
    if (fuse >= 0) {
      this.bFuse[b] -= dt;
      if (this.bFuse[b] <= 0) {
        this.bFuse[b] = -2;
        this.bReload[b] = MINE_REARM;
        this.at[0] = this.bX[b];
        this.at[1] = this.bY[b];
        this.explode(X_MINE);
      }
      return;
    }
    const io = this.io;
    io[0] = this.bX[b];
    io[1] = this.bY[b];
    io[2] = RANGE[B_MINE];
    this.chainLen = 0;
    if (this.nearestBug() >= 0) this.bFuse[b] = MINE_FUSE;
  }

  private updateProjectiles(dt: number): void {
    const nav = this.map.nav;
    const navInv = 1 / nav.cellSize;
    const ng = nav.size;
    const blocked = nav.blocked;
    const ws = this.map.worldSize;
    const { hp, alive } = this.store;
    const io = this.io;
    let live = 0;
    for (let p = 0; p < this.pCount; p++) {
      if (!this.pAlive[p]) continue;
      const kind = this.pKind[p];
      const x = this.pX[p];
      const y = this.pY[p];
      this.pPX[p] = x;
      this.pPY[p] = y;
      this.pAge[p] += dt;
      let life = (this.pLife[p] -= dt);

      if (kind === P_ORBITAL) {
        if (life <= 0) {
          this.freeProjectile(p);
          this.at[0] = x;
          this.at[1] = y;
          this.explode(X_ORBITAL);
        } else live++;
        continue;
      }

      // За цей крок снаряд пролітає лише до кінця свого життя.
      const f = life < 0 ? (dt + life) / dt : 1;
      let nx = x + this.pVX[p] * dt * f;
      let ny = y + this.pVY[p] * dt * f;

      if (kind === P_MORTAR) {
        this.pX[p] = nx;
        this.pY[p] = ny;
        if (life <= 0) {
          this.freeProjectile(p);
          this.at[0] = nx;
          this.at[1] = ny;
          this.explode(X_MORTAR);
        } else live++;
        continue;
      }

      // Кулі й фугаси: хто на відрізку польоту — той і отримує.
      if (kind !== P_FLAME) {
        io[0] = x;
        io[1] = y;
        io[2] = nx;
        io[3] = ny;
        const hit = this.segmentHit();
        if (hit >= 0) {
          this.freeProjectile(p);
          if (kind === P_BULLET) {
            hp[hit] -= TURRET_DMG;
            if (hp[hit] <= 0 && alive[hit]) this.killBug(hit);
          } else {
            const t = io[4];
            this.at[0] = x + (nx - x) * t;
            this.at[1] = y + (ny - y) * t;
            this.explode(X_CANNON);
          }
          continue;
        }
      }

      this.pTravel[p] += Math.sqrt((nx - x) * (nx - x) + (ny - y) * (ny - y));
      const gx = (nx * navInv) | 0;
      const gy = (ny * navInv) | 0;
      const out = nx < 0 || ny < 0 || nx >= ws || ny >= ws;
      const rock = !out && this.pTravel[p] > MUZZLE_CLEAR && blocked[gy * ng + gx] === 1;
      if (rock || out || life <= 0) {
        this.freeProjectile(p);
        if (rock) {
          // Влучили в скелю: зупиняємось на її краю (позиція попереднього кроку).
          nx = x;
          ny = y;
        }
        const at = this.at;
        at[0] = at[2] = nx;
        at[1] = at[3] = ny;
        if (kind === P_SHELL) this.explode(X_CANNON);
        else if (kind === P_FLAME) this.igniteAt();
        else if (rock) {
          at[4] = 1.5;
          at[5] = 0.15;
          this.effect(E_SPARK);
        }
        continue;
      }
      this.pX[p] = nx;
      this.pY[p] = ny;
      live++;
    }
    this.projectileCount = live;
  }

  /**
   * Перший живий жук на відрізку io[0..3] (DDA по клітинках spatial hash у порядку польоту).
   * io[4] — параметр t ∈ [0, 1] точки влучання.
   */
  private segmentHit(): number {
    const io = this.io;
    const x0 = io[0];
    const y0 = io[1];
    const x1 = io[2];
    const y1 = io[3];
    const hash = this.hash;
    const inv = hash.invCell;
    const w = hash.w;
    const hMax = hash.h - 1;
    const { cellStart, sortedIndex, sortedX, sortedY, sortedR } = hash;
    const alive = this.store.alive;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy + 1e-9;
    const gx0 = x0 * inv;
    const gy0 = y0 * inv;
    let cx = Math.floor(gx0);
    let cy = Math.floor(gy0);
    const ex = Math.floor(x1 * inv);
    const ey = Math.floor(y1 * inv);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const gdx = dx * inv;
    const gdy = dy * inv;
    const tDeltaX = gdx !== 0 ? Math.abs(1 / gdx) : Infinity;
    const tDeltaY = gdy !== 0 ? Math.abs(1 / gdy) : Infinity;
    let tMaxX = gdx !== 0 ? (stepX > 0 ? cx + 1 - gx0 : gx0 - cx) * tDeltaX : Infinity;
    let tMaxY = gdy !== 0 ? (stepY > 0 ? cy + 1 - gy0 : gy0 - cy) * tDeltaY : Infinity;
    let best = -1;
    let bestT = 2;
    for (let guard = 0; guard < 128; guard++) {
      if (cx >= 0 && cy >= 0 && cx < w && cy <= hMax) {
        const c = cy * w + cx;
        for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
          const bx = sortedX[k] - x0;
          const by = sortedY[k] - y0;
          let t = (bx * dx + by * dy) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ox = bx - dx * t;
          const oy = by - dy * t;
          const r = sortedR[k] + 0.2;
          if (ox * ox + oy * oy < r * r && t < bestT) {
            const i = sortedIndex[k];
            if (alive[i]) {
              bestT = t;
              best = i;
            }
          }
        }
        if (best >= 0) break;
      }
      if (cx === ex && cy === ey) break;
      if (tMaxX < tMaxY) {
        tMaxX += tDeltaX;
        cx += stepX;
      } else {
        tMaxY += tDeltaY;
        cy += stepY;
      }
    }
    io[4] = bestT > 1 ? 1 : bestT;
    return best;
  }

  /** Вибух виду `kind` у точці at[0..1]: шкода всім жукам у радіусі (спадає до краю) + ефект. */
  private explode(kind: number): void {
    const at = this.at;
    const x = at[0];
    const y = at[1];
    const R = AOE_R[kind];
    const dmg = AOE_DMG[kind];
    at[2] = x;
    at[3] = y;
    at[4] = R;
    at[5] = 0.25 + R * 0.025;
    this.effect(E_EXPLOSION);
    const hash = this.hash;
    const inv = hash.invCell;
    const w = hash.w;
    const { cellStart, sortedIndex } = hash;
    const { posX, posY, hp, alive, radius } = this.store;
    // Рамка пошуку ширша на радіус командира: вибух біля краю його тіла теж зачіпає.
    const RB = R + COMMANDER_RADIUS;
    const x0 = Math.max(0, ((x - RB) * inv) | 0);
    const y0 = Math.max(0, ((y - RB) * inv) | 0);
    const x1 = Math.min(w - 1, ((x + RB) * inv) | 0);
    const y1 = Math.min(hash.h - 1, ((y + RB) * inv) | 0);
    const invR = 1 / R;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cy * w + cx;
        for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
          const i = sortedIndex[k];
          if (!alive[i]) continue;
          const dx = posX[i] - x;
          const dy = posY[i] - y;
          const d2 = dx * dx + dy * dy;
          const rr = R + radius[i];
          if (d2 >= rr * rr) continue;
          // Відстань — до краю тіла, а не до центру (для великих жуків це суттєво).
          let e = Math.sqrt(d2) - radius[i];
          if (e < 0) e = 0;
          hp[i] -= dmg * (1 - (1 - AOE_EDGE) * e * invR);
          if (hp[i] <= 0) this.killBug(i);
        }
      }
    }
  }

  /** Зона вогню в точці at[0..1]. */
  private igniteAt(): void {
    if (this.fFreeTop === 0) return;
    const f = this.fFree[--this.fFreeTop];
    if (f >= this.fCount) this.fCount = f + 1;
    this.fAlive[f] = 1;
    this.fX[f] = this.at[0];
    this.fY[f] = this.at[1];
    this.fAge[f] = 0;
  }

  /** Зони вогню: шкода кожному жукові всередині, щокроку. */
  private updateFires(dt: number): void {
    const hash = this.hash;
    const inv = hash.invCell;
    const w = hash.w;
    const hMax = hash.h - 1;
    const { cellStart, sortedIndex } = hash;
    const { posX, posY, hp, alive } = this.store;
    const R = FIRE_RADIUS;
    const dmg = FIRE_DPS * dt;
    const burnStep = this.burnStep;
    const stepNo = ++this.stepNo;
    let live = 0;
    for (let f = 0; f < this.fCount; f++) {
      if (!this.fAlive[f]) continue;
      this.fAge[f] += dt;
      if (this.fAge[f] >= FIRE_LIFE) {
        this.fAlive[f] = 0;
        this.fFree[this.fFreeTop++] = f;
        continue;
      }
      live++;
      const x = this.fX[f];
      const y = this.fY[f];
      const x0 = Math.max(0, ((x - R) * inv) | 0);
      const y0 = Math.max(0, ((y - R) * inv) | 0);
      const x1 = Math.min(w - 1, ((x + R) * inv) | 0);
      const y1 = Math.min(hMax, ((y + R) * inv) | 0);
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const c = cy * w + cx;
          for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
            const i = sortedIndex[k];
            if (!alive[i]) continue;
            const dx = posX[i] - x;
            const dy = posY[i] - y;
            if (dx * dx + dy * dy >= R * R || burnStep[i] === stepNo) continue;
            burnStep[i] = stepNo;
            hp[i] -= dmg;
            if (hp[i] <= 0) this.killBug(i);
          }
        }
      }
    }
    while (this.fCount > 0 && !this.fAlive[this.fCount - 1]) this.fCount--;
    this.fireCount = live;
  }

  private updateEffects(dt: number): void {
    // Ефекти компактні: живі тримаємо щільним префіксом (переносимо останній на місце мертвого).
    let n = this.eCount;
    for (let e = 0; e < n; ) {
      this.eAge[e] += dt;
      if (this.eAge[e] < this.eLife[e]) {
        e++;
        continue;
      }
      n--;
      this.eKind[e] = this.eKind[n];
      this.eAX[e] = this.eAX[n];
      this.eAY[e] = this.eAY[n];
      this.eBX[e] = this.eBX[n];
      this.eBY[e] = this.eBY[n];
      this.eSize[e] = this.eSize[n];
      this.eAge[e] = this.eAge[n];
      this.eLife[e] = this.eLife[n];
    }
    this.eCount = n;
  }

  /** Ефект: at = [ax, ay, bx, by, розмір, тривалість]. */
  private effect(kind: number): void {
    if (this.eCount >= MAX_FX) return;
    const at = this.at;
    const e = this.eCount++;
    this.eKind[e] = kind;
    this.eAX[e] = at[0];
    this.eAY[e] = at[1];
    this.eBX[e] = at[2];
    this.eBY[e] = at[3];
    this.eSize[e] = at[4];
    this.eAge[e] = 0;
    this.eLife[e] = at[5];
  }

  private killBug(i: number): void {
    if (this.store.type[i] === COMMANDER_TYPE) this.commanderKills++;
    this.store.free(i);
    this.kills++;
  }

  private allocProjectile(kind: number): number {
    if (this.pFreeTop === 0) return -1;
    const p = this.pFree[--this.pFreeTop];
    if (p >= this.pCount) this.pCount = p + 1;
    this.pAlive[p] = 1;
    this.pKind[p] = kind;
    this.pAge[p] = 0;
    this.pTravel[p] = 0;
    this.pVX[p] = 0;
    this.pVY[p] = 0;
    return p;
  }

  private freeProjectile(p: number): void {
    this.pAlive[p] = 0;
    this.pFree[this.pFreeTop++] = p;
    while (this.pCount > 0 && !this.pAlive[this.pCount - 1]) this.pCount--;
  }

  // =====================================================================================
  // Рендер: пакування FX-інстансів (раз на кадр)
  // =====================================================================================

  /**
   * Наступний вільний FX-інстанс (зсув у frame.instances) або −1. Значення пишемо на місці, а не
   * через pushFx(…): виклик із 8 дробовими аргументами V8 пакує в HeapNumber — для сотень
   * інстансів щокадру це мегабайти сміття за секунду.
   */
  private fxSlot(frame: FxFrame): number {
    if ((frame.count + 1) * FX_FLOATS > frame.instances.length) return -1;
    return frame.count++ * FX_FLOATS;
  }

  /**
   * Робочі зони: усі — лише з showZones (клавіша Z), інакше тільки в будівлі під курсором (hovered).
   */
  packRender(frame: FxFrame, showZones: boolean, hovered: number, timeSec: number): void {
    frame.count = 0;
    const d = frame.instances;
    const obsHp = this.obstacles.hp;
    const obsHpMax = this.obstacles.hpMax;
    let o: number;

    // --- Під жуками: робочі зони, міни.
    for (let b = 0; b < this.bCount; b++) {
      if (!this.bAlive[b]) continue;
      const t = this.bType[b];
      if (t <= B_TESLA && (showZones || b === hovered)) {
        if ((o = this.fxSlot(frame)) < 0) break;
        d[o] = this.bX[b];
        d[o + 1] = this.bY[b];
        d[o + 2] = MIN_RANGE[t];
        d[o + 3] = 0;
        d[o + 4] = RANGE[t];
        d[o + 5] = FX_SECTOR;
        d[o + 6] = HALF_ARC[t];
        d[o + 7] = this.bAim[b];
      } else if (t === B_MINE) {
        if ((o = this.fxSlot(frame)) < 0) break;
        d[o] = this.bX[b];
        d[o + 1] = this.bY[b];
        d[o + 2] = 0;
        d[o + 3] = 0;
        d[o + 4] = RADIUS[B_MINE];
        d[o + 5] = FX_MINE;
        // 0 — чекає, 1 — зведена, 2..3 — перезаряджається (дробова частина — прогрес).
        const fuse = this.bFuse[b];
        d[o + 6] = fuse === -2 ? 2 + Math.min(0.999, 1 - this.bReload[b] / MINE_REARM) : fuse >= 0 ? 1 : 0;
        d[o + 7] = b * 0.37;
      }
    }
    frame.under = frame.count;

    // --- Над жуками: вогонь, стволи, снаряди, ефекти, смужки міцності.
    for (let f = 0; f < this.fCount; f++) {
      if (!this.fAlive[f]) continue;
      if ((o = this.fxSlot(frame)) < 0) break;
      d[o] = this.fX[f];
      d[o + 1] = this.fY[f];
      d[o + 2] = 0;
      d[o + 3] = 0;
      d[o + 4] = FIRE_RADIUS;
      d[o + 5] = FX_FIRE;
      d[o + 6] = this.fAge[f] / FIRE_LIFE;
      d[o + 7] = f * 0.61;
    }
    for (let b = 0; b < this.bCount; b++) {
      if (!this.bAlive[b]) continue;
      const t = this.bType[b];
      const ob = this.bObs[b];
      const frac = ob >= 0 ? obsHp[ob] / obsHpMax[ob] : 1;
      if (t <= B_TESLA) {
        if ((o = this.fxSlot(frame)) < 0) break;
        d[o] = this.bX[b];
        d[o + 1] = this.bY[b];
        d[o + 2] = this.bFlash[b] > 0 ? 1 : 0;
        d[o + 3] = frac;
        d[o + 4] = RADIUS[t];
        d[o + 5] = FX_HEAD;
        d[o + 6] = t;
        d[o + 7] = this.bHead[b];
      }
      if (frac < 0.995) {
        if ((o = this.fxSlot(frame)) < 0) break;
        const r = t === B_WALL ? 2 : RADIUS[t];
        d[o] = this.bX[b];
        d[o + 1] = this.bY[b] - r - 2.5;
        d[o + 2] = 0;
        d[o + 3] = 0;
        d[o + 4] = t === B_WALL ? Math.min(8, this.bLen[b] * 0.4) : Math.max(3, r);
        d[o + 5] = FX_HP_BAR;
        d[o + 6] = frac;
        d[o + 7] = 0;
      }
    }
    for (let p = 0; p < this.pCount; p++) {
      if (!this.pAlive[p]) continue;
      if ((o = this.fxSlot(frame)) < 0) break;
      const kind = this.pKind[p];
      // Снаряди: a = позиція на початку кроку, b — зараз (рендер інтерполює між ними).
      d[o] = this.pPX[p];
      d[o + 1] = this.pPY[p];
      d[o + 2] = this.pX[p];
      d[o + 3] = this.pY[p];
      d[o + 7] = 0;
      if (kind === P_BULLET) {
        d[o + 4] = 0.3;
        d[o + 5] = FX_TRACER;
        d[o + 6] = 0;
      } else if (kind === P_SHELL) {
        d[o + 4] = 1.1;
        d[o + 5] = FX_SHELL;
        d[o + 6] = 0;
      } else if (kind === P_MORTAR) {
        const T = this.pTotal[p];
        d[o + 4] = 1.2;
        d[o + 5] = FX_MORTAR;
        d[o + 6] = this.pAge[p] / T;
        d[o + 7] = Math.min(55, 12 + T * 14); // висота дуги
      } else if (kind === P_FLAME) {
        d[o + 4] = 2.2;
        d[o + 5] = FX_FLAME;
        d[o + 6] = this.pAge[p] / this.pTotal[p];
        d[o + 7] = p * 0.13;
      } else {
        d[o] = this.pX[p];
        d[o + 1] = this.pY[p];
        d[o + 4] = 2.5;
        d[o + 5] = FX_ORBITAL_SHELL;
        d[o + 6] = 1 - this.pLife[p] / this.pTotal[p];
        d[o + 7] = p * 0.29;
      }
    }
    for (let e = 0; e < this.eCount; e++) {
      if ((o = this.fxSlot(frame)) < 0) break;
      const k = this.eKind[e];
      d[o] = this.eAX[e];
      d[o + 1] = this.eAY[e];
      d[o + 2] = this.eBX[e];
      d[o + 3] = this.eBY[e];
      d[o + 4] = this.eSize[e];
      d[o + 5] = k === E_EXPLOSION ? FX_EXPLOSION : k === E_LIGHTNING ? FX_LIGHTNING : k === E_SPARK ? FX_SPARK : FX_ORBITAL_MARK;
      d[o + 6] = this.eAge[e] / this.eLife[e];
      d[o + 7] = e * 0.71 + timeSec;
    }
    if ((o = this.fxSlot(frame)) >= 0) {
      const bunker = this.map.bunker;
      d[o] = bunker.x;
      d[o + 1] = bunker.y;
      d[o + 2] = 0;
      d[o + 3] = 0;
      d[o + 4] = bunker.r + 3.5;
      d[o + 5] = FX_CORE_HP;
      d[o + 6] = this.map.coreHp / this.map.coreHpMax;
      d[o + 7] = 0;
    }
  }
}
