import { OBSTACLE_CIRCLE, OBSTACLE_RECT, OBSTACLE_STYLE_ROCK, type ObstacleSet } from '../shared/contracts';
import {
  BUILDING_NAV_COST,
  BUILDING_NAV_COST_MAX,
  BUILDING_NAV_COST_MIN,
  BUILDING_NAV_STEP,
  BUILDING_REGEN_DELAY,
  BUILDING_REGEN_RATE,
  CENTER_CLEAR_RADIUS,
  EDGE_CLEAR_MARGIN,
  MAX_BUILDING_OBSTACLES,
  OBSTACLE_HP_PER_AREA,
} from './config';
import type { ErosionField } from './erosion';
import { mulberry32 } from './rng';

/**
 * Генерує скелі за seed. Скелі ставляться кластерами (1–4 поруч), щоб виглядало
 * природніше й утворювались «коридори». Центр і смуга вздовж країв лишаються вільними.
 */
export function generateObstacles(seed: number, worldSize: number): ObstacleSet {
  const rng = mulberry32(seed);
  const targetArea = worldSize * worldSize * (0.06 + rng() * 0.03);
  const center = worldSize / 2;

  const kind: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const as: number[] = [];
  const bs: number[] = [];
  const angles: number[] = [];

  let area = 0;
  for (let attempt = 0; attempt < 4000 && area < targetArea; attempt++) {
    const cx = EDGE_CLEAR_MARGIN + rng() * (worldSize - 2 * EDGE_CLEAR_MARGIN);
    const cy = EDGE_CLEAR_MARGIN + rng() * (worldSize - 2 * EDGE_CLEAR_MARGIN);
    const n = 1 + Math.floor(rng() * 4);
    for (let k = 0; k < n; k++) {
      const ox = cx + (rng() - 0.5) * 70;
      const oy = cy + (rng() - 0.5) * 70;
      let a: number;
      let b: number;
      let angle = 0;
      let bound: number;
      let shapeArea: number;
      const isCircle = rng() < 0.55;
      if (isCircle) {
        a = 5 + Math.pow(rng(), 1.6) * 32;
        b = a;
        bound = a;
        shapeArea = Math.PI * a * a;
      } else {
        a = 4 + Math.pow(rng(), 1.3) * 38;
        b = 3 + Math.pow(rng(), 1.5) * 18;
        angle = rng() * Math.PI;
        bound = Math.hypot(a, b);
        shapeArea = 4 * a * b;
      }
      if (ox - bound < EDGE_CLEAR_MARGIN || oy - bound < EDGE_CLEAR_MARGIN) continue;
      if (ox + bound > worldSize - EDGE_CLEAR_MARGIN || oy + bound > worldSize - EDGE_CLEAR_MARGIN) continue;
      if (Math.hypot(ox - center, oy - center) - bound < CENTER_CLEAR_RADIUS) continue;

      kind.push(isCircle ? OBSTACLE_CIRCLE : OBSTACLE_RECT);
      xs.push(ox);
      ys.push(oy);
      as.push(a);
      bs.push(b);
      angles.push(angle);
      area += shapeArea; // перекриття рахуються двічі — точне покриття рахує nav-грід
    }
  }

  // Масиви одразу з запасом під будівлі гравця — щоб будівництво не перевиділяло пам'ять.
  const count = kind.length;
  const cap = count + MAX_BUILDING_OBSTACLES;
  const f32 = (src: number[], map?: (v: number) => number) => {
    const a = new Float32Array(cap);
    for (let i = 0; i < count; i++) a[i] = map ? map(src[i]) : src[i];
    return a;
  };
  const kinds = new Uint8Array(cap);
  kinds.set(kind);
  const alive = new Uint8Array(cap);
  alive.fill(1, 0, count);
  return {
    count,
    rockCount: count,
    kind: kinds,
    style: new Uint8Array(cap).fill(OBSTACLE_STYLE_ROCK),
    owner: new Int32Array(cap).fill(-1),
    navCost: new Float32Array(cap),
    alive,
    damage: new Float32Array(cap),
    x: f32(xs),
    y: f32(ys),
    a: f32(as),
    b: f32(bs),
    cos: f32(angles, Math.cos),
    sin: f32(angles, Math.sin),
  };
}

export function obstacleBound(set: ObstacleSet, i: number): number {
  return set.kind[i] === OBSTACLE_CIRCLE ? set.a[i] : Math.hypot(set.a[i], set.b[i]);
}

/** Знакова відстань від точки до перешкоди (<0 — всередині). */
export function obstacleSignedDistance(set: ObstacleSet, i: number, px: number, py: number): number {
  const dx = px - set.x[i];
  const dy = py - set.y[i];
  if (set.kind[i] === OBSTACLE_CIRCLE) return Math.sqrt(dx * dx + dy * dy) - set.a[i];
  const c = set.cos[i];
  const s = set.sin[i];
  const qx = Math.abs(c * dx + s * dy) - set.a[i];
  const qy = Math.abs(-s * dx + c * dy) - set.b[i];
  const ox = qx > 0 ? qx : 0;
  const oy = qy > 0 ? qy : 0;
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0);
}

/**
 * Грубий грід для швидкого пошуку перешкод біля жука (CSR-формат: cellStart + items).
 * Перешкода реєструється в усіх клітинках, які перетинає її AABB, розширений на `pad`
 * (максимальний радіус жука) — тож жукові досить перевірити лише свою клітинку.
 * Будівлі гравця додаються й зникають під час гри → грід перебудовується (rebuildGrid, ~0.1 мс).
 */
export class ObstacleField {
  readonly set: ObstacleSet;
  readonly cellSize: number;
  readonly invCell: number;
  readonly w: number;
  readonly cellStart: Uint32Array;
  items: Uint16Array;
  private readonly pad: number;
  private readonly cellCounts: Uint32Array;
  private readonly cellCursor: Uint32Array;

  /**
   * Вхід/вихід resolve(): [x, y, r] → [x', y', r, індекс скелі, що виштовхнула (або −1),
   * точка контакту x/y, нормаль усередину x/y].
   * Чому не аргументи й не поля outX/outY:
   * resolve() надто велика для інлайнінгу, а при звичайному виклику V8 передає double-аргументи
   * запакованими (HeapNumber) — це 2–3 алокації на жука за крок, ~1 МБ сміття на крок при 50k.
   * У Float64Array числа лежать «як є», без пакування → нуль алокацій.
   */
  readonly io = new Float64Array(8);

  // --- Руйнування. Початкові розміри, здоров'я (∝ площі) і накопичена за крок шкода.
  readonly baseA: Float32Array;
  readonly baseB: Float32Array;
  readonly hp: Float32Array;
  readonly hpMax: Float32Array;
  readonly pendingDamage: Float32Array;
  /** Масштаб (для будівель — частка міцності), з яким востаннє будувався flow field. */
  readonly navScale: Float32Array;
  /**
   * Множник отриманої шкоди: 1 — звичайно, менше — броньована (стіна, підтримана кутами).
   * Для скель завжди 1.
   */
  readonly armor: Float32Array;
  /** Секунд від останньої шкоди (для авторегенерації будівель). */
  readonly sinceHit: Float32Array;
  /** Будівлі (owner), знищені в останньому applyDamage(). */
  readonly destroyedOwners: Int32Array;
  destroyedCount = 0;
  private readonly freeSlots: Int32Array;
  private freeTop = 0;

  constructor(
    set: ObstacleSet,
    worldSize: number,
    cellSize: number,
    pad: number,
    private readonly erosion: ErosionField,
  ) {
    this.set = set;
    this.cellSize = cellSize;
    this.pad = pad;
    const cap = set.kind.length;
    this.baseA = Float32Array.from(set.a);
    this.baseB = Float32Array.from(set.b);
    this.hpMax = new Float32Array(cap);
    for (let i = 0; i < set.rockCount; i++) {
      const area = set.kind[i] === OBSTACLE_CIRCLE ? Math.PI * set.a[i] * set.a[i] : 4 * set.a[i] * set.b[i];
      this.hpMax[i] = area * OBSTACLE_HP_PER_AREA;
    }
    this.hp = Float32Array.from(this.hpMax);
    this.pendingDamage = new Float32Array(cap);
    this.navScale = new Float32Array(cap).fill(1);
    this.armor = new Float32Array(cap).fill(1);
    this.sinceHit = new Float32Array(cap);
    this.destroyedOwners = new Int32Array(cap);
    // Вільні слоти під будівлі: видаються від менших індексів.
    this.freeSlots = new Int32Array(cap - set.rockCount);
    for (let i = cap - 1; i >= set.rockCount; i--) this.freeSlots[this.freeTop++] = i;
    this.invCell = 1 / cellSize;
    const w = Math.ceil(worldSize / cellSize);
    this.w = w;
    const numCells = w * w;
    this.cellStart = new Uint32Array(numCells + 1);
    this.cellCounts = new Uint32Array(numCells);
    this.cellCursor = new Uint32Array(numCells);
    this.items = new Uint16Array(0);
    this.rebuildGrid();
  }

  /** Перебудовує CSR-грід (лише живі перешкоди). Не гарячий шлях: виклик при будівництві/знесенні. */
  rebuildGrid(): void {
    const { set, w, cellSize, pad, cellCounts: counts, cellCursor: cursor, cellStart } = this;
    const numCells = w * w;
    counts.fill(0);
    const visit = (i: number, write: boolean) => {
      const reach = obstacleBound(set, i) + pad;
      const x0 = Math.max(0, Math.floor((set.x[i] - reach) / cellSize));
      const y0 = Math.max(0, Math.floor((set.y[i] - reach) / cellSize));
      const x1 = Math.min(w - 1, Math.floor((set.x[i] + reach) / cellSize));
      const y1 = Math.min(w - 1, Math.floor((set.y[i] + reach) / cellSize));
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const c = cy * w + cx;
          if (write) this.items[cursor[c]++] = i;
          else counts[c]++;
        }
      }
    };
    for (let i = 0; i < set.count; i++) if (set.alive[i]) visit(i, false);
    cellStart[0] = 0;
    for (let c = 0; c < numCells; c++) cellStart[c + 1] = cellStart[c] + counts[c];
    if (this.items.length < cellStart[numCells]) this.items = new Uint16Array(cellStart[numCells] * 2);
    cursor.set(cellStart.subarray(0, numCells));
    for (let i = 0; i < set.count; i++) if (set.alive[i]) visit(i, true);
  }

  /** Додає будівлю-перешкоду. Повертає індекс або −1 (немає місця). Грід треба перебудувати. */
  addBuilding(
    kind: number,
    style: number,
    x: number,
    y: number,
    a: number,
    b: number,
    angle: number,
    hp: number,
    owner: number,
    inNav: boolean,
  ): number {
    if (this.freeTop === 0) return -1;
    const i = this.freeSlots[--this.freeTop];
    const set = this.set;
    if (i >= set.count) set.count = i + 1;
    set.kind[i] = kind;
    set.style[i] = style;
    set.owner[i] = owner;
    set.alive[i] = 1;
    set.damage[i] = 0;
    set.x[i] = x;
    set.y[i] = y;
    set.a[i] = this.baseA[i] = a;
    set.b[i] = this.baseB[i] = b;
    set.cos[i] = Math.cos(angle);
    set.sin[i] = Math.sin(angle);
    this.hp[i] = this.hpMax[i] = hp;
    this.armor[i] = 1;
    this.sinceHit[i] = 0;
    this.pendingDamage[i] = 0;
    this.navScale[i] = 1;
    set.navCost[i] = inNav ? 0 : -1;
    this.updateNavCost(i);
    return i;
  }

  /** Прибирає будівлю (знесення гравцем або знищення). Грід треба перебудувати. */
  removeBuilding(i: number): void {
    const set = this.set;
    if (i < set.rockCount || !set.alive[i]) return;
    set.alive[i] = 0;
    set.owner[i] = -1;
    this.freeSlots[this.freeTop++] = i;
    while (set.count > set.rockCount && !set.alive[set.count - 1] && set.owner[set.count - 1] < 0) set.count--;
  }

  /** Ціна проходу крізь будівлю для flow field ∝ ефективній міцності (з урахуванням броні). */
  updateNavCost(i: number): void {
    if (this.set.navCost[i] < 0) return;
    const eff = this.hp[i] / this.armor[i];
    const c = eff * BUILDING_NAV_COST;
    this.set.navCost[i] = c < BUILDING_NAV_COST_MIN ? BUILDING_NAV_COST_MIN : c > BUILDING_NAV_COST_MAX ? BUILDING_NAV_COST_MAX : c;
  }

  /** Індекс клітинки грубого гріда (щоб викликати resolve() лише там, де є скелі). */
  cellOf(x: number, y: number): number {
    const w = this.w;
    let cx = (x * this.invCell) | 0;
    let cy = (y * this.invCell) | 0;
    if (cx < 0) cx = 0;
    else if (cx >= w) cx = w - 1;
    if (cy < 0) cy = 0;
    else if (cy >= w) cy = w - 1;
    return cy * w + cx;
  }

  /**
   * Виштовхує коло io = [x, y, r] з усіх перешкод клітинки `c`. Результат — у io[0], io[1];
   * io[3] — перешкода, що виштовхнула останньою (−1 — жодна), io[4..5] — точка контакту на її
   * поверхні, io[6..7] — нормаль усередину перешкоди (для корозії).
   * Ковзання вздовж стіни виходить автоматично: симуляція виводить швидкість із
   * фактичного зсуву, тож нормальна до стіни компонента просто «з'їдається».
   *
   * Кратери ерозії (див. erosion.ts) — вільний простір усередині скель: коло, що цілком у
   * кратері, скелю не зачіпає, а коло, що зачепило матеріал біля кратера, повертається в кратер,
   * якщо так ближче, ніж виходити назовні. Для будівель кратери не діють.
   */
  resolve(c: number): void {
    const io = this.io;
    let x = io[0];
    let y = io[1];
    const r = io[2];
    const start = this.cellStart[c];
    const end = this.cellStart[c + 1];
    const { kind, alive, x: ox, y: oy, a, b, cos, sin } = this.set;
    const rocks = this.set.rockCount;
    const erosion = this.erosion;
    const eio = erosion.io;
    const eroded = erosion.count > 0;
    let touched = -1;
    let ux = 0;
    let uy = 0;
    const items = this.items;
    // Скелі в кластерах перекриваються: виштовхування з однієї може загнати в сусідню.
    // Кілька ітерацій розв'язують такі «кишені»; зазвичай друга ітерація вже нічого не змінює.
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (let k = start; k < end; k++) {
        const o = items[k];
        if (alive[o] === 0) continue;
        const dx = x - ox[o];
        const dy = y - oy[o];
        let nx: number;
        let ny: number;
        if (kind[o] === OBSTACLE_CIRCLE) {
          const rr = a[o] + r;
          const d2 = dx * dx + dy * dy;
          if (d2 >= rr * rr) continue;
          if (d2 > 1e-12) {
            const s = rr / Math.sqrt(d2);
            nx = ox[o] + dx * s;
            ny = oy[o] + dy * s;
          } else {
            nx = ox[o] + rr;
            ny = y;
          }
        } else {
          // Переходимо в локальні координати прямокутника (поворот на -θ).
          const c0 = cos[o];
          const s0 = sin[o];
          let lx = c0 * dx + s0 * dy;
          let ly = -s0 * dx + c0 * dy;
          const hx = a[o];
          const hy = b[o];
          const qx = lx < -hx ? -hx : lx > hx ? hx : lx;
          const qy = ly < -hy ? -hy : ly > hy ? hy : ly;
          const ex = lx - qx;
          const ey = ly - qy;
          const e2 = ex * ex + ey * ey;
          if (e2 > 1e-12) {
            if (e2 >= r * r) continue;
            // Центр зовні, але коло зачіпає край: штовхаємо від найближчої точки.
            const e = Math.sqrt(e2);
            const push = (r - e) / e;
            lx += ex * push;
            ly += ey * push;
          } else {
            // Центр усередині прямокутника: виходимо по осі мінімального проникнення.
            const px = hx - Math.abs(lx);
            const py = hy - Math.abs(ly);
            if (px < py) lx = (lx < 0 ? -1 : 1) * (hx + r);
            else ly = (ly < 0 ? -1 : 1) * (hy + r);
          }
          nx = ox[o] + c0 * lx - s0 * ly;
          ny = oy[o] + s0 * lx + c0 * ly;
        }
        if (eroded && o < rocks) {
          eio[0] = x;
          eio[1] = y;
          eio[2] = r;
          erosion.escape();
          if (eio[0] === 1) continue; // цілком у кратері — цієї скелі не торкається
          const mx = nx - x;
          const my = ny - y;
          if (eio[3] * eio[3] < mx * mx + my * my) {
            nx = eio[1];
            ny = eio[2];
          }
        }
        ux = nx - x;
        uy = ny - y;
        x = nx;
        y = ny;
        moved = true;
        touched = o;
      }
      if (!moved) break;
    }
    io[0] = x;
    io[1] = y;
    io[3] = touched;
    if (touched >= 0) {
      const l = Math.sqrt(ux * ux + uy * uy) + 1e-9;
      io[6] = -ux / l;
      io[7] = -uy / l;
      io[4] = x + io[6] * r;
      io[5] = y + io[7] * r;
    }
  }

  /**
   * Застосовує накопичену за крок шкоду. navDirty — flow field застарів (будівля помітно
   * ослабла чи впала, скеля розсипалась).
   */
  applyDamage(): { changed: boolean; navDirty: boolean; destroyed: number } {
    const { set, hp, hpMax, pendingDamage, navScale } = this;
    let changed = false;
    let navDirty = false;
    let destroyed = 0;
    this.destroyedCount = 0;
    const rocks = set.rockCount;
    for (let i = 0; i < set.count; i++) {
      const dmg = pendingDamage[i];
      if (dmg <= 0) continue;
      pendingDamage[i] = 0;
      if (!set.alive[i]) continue;
      changed = true;
      if (i >= rocks) {
        // Будівля: не зменшується, а тріскається; при 0 — руйнується. Ціна проходу для flow
        // field падає разом із міцністю, тож жуки охочіше йдуть крізь пошкоджену стіну.
        hp[i] -= dmg * this.armor[i];
        this.sinceHit[i] = 0;
        const frac = hp[i] > 0 ? hp[i] / hpMax[i] : 0;
        set.damage[i] = 1 - frac;
        const inNav = set.navCost[i] >= 0;
        if (frac <= 0) {
          this.destroyedOwners[this.destroyedCount++] = set.owner[i];
          if (inNav) navDirty = true;
          continue;
        }
        if (inNav && navScale[i] - frac > BUILDING_NAV_STEP) {
          navScale[i] = frac;
          this.updateNavCost(i);
          navDirty = true;
        }
        continue;
      }
      // Скеля: форма не змінюється — її локально роз'їдають кратери (erosion.ts). Тут лише облік
      // з'їденого: коли шкода зрівнялась зі «здоров'ям» (∝ площі), рештки розсипаються.
      hp[i] -= dmg;
      set.damage[i] = 1 - (hp[i] > 0 ? hp[i] / hpMax[i] : 0);
      if (hp[i] <= 0) {
        set.alive[i] = 0;
        set.damage[i] = 1;
        navDirty = true;
        destroyed++;
      }
    }
    this.damageResult.changed = changed;
    this.damageResult.navDirty = navDirty;
    this.damageResult.destroyed = destroyed;
    return this.damageResult;
  }

  private readonly damageResult = { changed: false, navDirty: false, destroyed: 0 };

  /**
   * Авторегенерація будівель: після BUILDING_REGEN_DELAY с без шкоди міцність росте на
   * BUILDING_REGEN_RATE від повної за секунду. Повертає бітову маску: 1 — щось відновилось
   * (оновити рендер), 2 — ціна проходу для flow field помітно зросла (перебудувати поле).
   */
  regenerate(dt: number): number {
    const { set, hp, hpMax, sinceHit, navScale } = this;
    let res = 0;
    for (let i = set.rockCount; i < set.count; i++) {
      if (!set.alive[i]) continue;
      if ((sinceHit[i] += dt) < BUILDING_REGEN_DELAY || hp[i] >= hpMax[i]) continue;
      hp[i] += hpMax[i] * BUILDING_REGEN_RATE * dt;
      if (hp[i] > hpMax[i]) hp[i] = hpMax[i];
      const frac = hp[i] / hpMax[i];
      set.damage[i] = 1 - frac;
      res |= 1;
      if (set.navCost[i] >= 0 && (frac - navScale[i] > BUILDING_NAV_STEP || (frac >= 1 && navScale[i] < 1))) {
        navScale[i] = frac;
        this.updateNavCost(i);
        res |= 2;
      }
    }
    return res;
  }
}
