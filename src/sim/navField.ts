import { OBSTACLE_CIRCLE, type ErosionData, type NavFieldData, type ObstacleSet } from '../shared/contracts';
import { IntMinHeap, KEY_SCALE } from './heap';
import { overBudget, type Job } from './jobs';

// Сусіди: 4 ортогональні + 4 діагональні.
const NX = [1, -1, 0, 0, 1, 1, -1, -1];
const NY = [0, 0, 1, -1, 1, -1, 1, -1];
const NCOST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

/**
 * Будує flow field до цілі:
 * 1. Растеризація перешкод у грід (клітинка заблокована, якщо її центр ближче за
 *    `inflate` до будь-якої живої скелі).
 * 2. Any-angle пошук (Lazy Theta*) від цілі → евклідова integration field `dist`
 *    і для кожної клітинки «батько» — точка, на яку з неї видно шлях до цілі.
 * 3. Поле напрямків: одиничний вектор від клітинки до її батька.
 *
 * Чому не звичайний Dijkstra по 8 сусідах: він міряє відстань «октагонально», і напрямки
 * квантуються в кілька фіксованих кутів. На відкритій місцевості цілі сектори отримують один
 * і той самий напрямок, жуки йдуть паралельно, доки не впруться в лінію стику секторів
 * (осі й діагоналі), і далі сунуть цією лінією — орда збирається в «зірку».
 * Theta* дозволяє батьком бути будь-яку клітинку в прямій видимості, тож на відкритій
 * місцевості кожна клітинка дивиться прямо на ціль, а за скелею — на її видимий кут.
 *
 * Скелі руйнуються, тож поле перебудовується під час гри. Тому:
 * - побудова — фонова задача (генератор, див. jobs.ts): ~80 мс розмазуються на десятки кадрів;
 * - два вихідні буфери (double buffering): нове поле пишеться в задній, поки жуки й рендер
 *   читають передній; підміна — по завершенні;
 * - усі робочі масиви (купа, parent, closed…) виділені один раз, і в циклах немає викликів із
 *   double-аргументами — інакше фонова перебудова генерувала б мегабайти сміття.
 *
 * Будівлі гравця (стіни, кути, підставки зброї) — не стіни для пошуку, а «дорогі» клітинки
 * (blocked = 2): вхід у таку клітинку коштує додатково navCost (∝ міцності). Тож жуки обходять
 * оборону, якщо обхід не надто довгий, а якщо бункер обнесено стіною повністю — йдуть
 * найдешевшим шляхом крізь найслабше місце й гризуть його. Через дорогі клітинки any-angle
 * «зрізи» не проходять (пряма видимість їх не перетинає), шлях іде грідом, клітинка за клітинкою.
 */
export class NavFieldBuilder {
  readonly size: number;
  readonly cellSize: number;
  /** Частка площі під скелями в останній побудові. */
  coverage = 0;

  private readonly n: number;
  private readonly minSd: Float32Array;
  private readonly parent: Int32Array;
  private readonly closed: Uint8Array;
  /** Додаткова ціна входу в клітинку будівлі (у клітинках). */
  private readonly pen: Float32Array;
  /** 1 — батько клітинки — її сусід по гріду (шлях крізь будівлю), LOS не перевіряємо. */
  private readonly gridParent: Uint8Array;
  private readonly heap: IntMinHeap;
  private readonly buffers: NavFieldData[];
  private back = 0;
  // Ціль у координатах клітинок (поля, а не аргументи — щоб lineOfSight брала лише цілі числа).
  private gX = 0;
  private gY = 0;
  private goalReach2 = 0;
  private maxDist = 0;
  private out!: NavFieldData;

  constructor(worldSize: number, size: number) {
    this.size = size;
    this.cellSize = worldSize / size;
    const n = size * size;
    this.n = n;
    this.minSd = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.closed = new Uint8Array(n);
    this.pen = new Float32Array(n);
    this.gridParent = new Uint8Array(n);
    this.heap = new IntMinHeap(n * 8 + 16);
    const make = (): NavFieldData => ({
      size,
      cellSize: this.cellSize,
      blocked: new Uint8Array(n),
      dist: new Float32Array(n),
      dirX: new Float32Array(n),
      dirY: new Float32Array(n),
      maxDist: 0,
    });
    this.buffers = [make(), make()];
  }

  /**
   * Фонова задача: будує поле в задній буфер і повертає його (він стає переднім).
   *
   * Генератор — лише тонкий диспетчер: уся важка робота — у звичайних методах, що обробляють
   * обмежену порцію (одну скелю, N вершин купи, N рядків). Причина — V8: генератори не
   * оптимізуються on-stack replacement'ом, і важкий цикл усередині генератора крутився б майже в
   * інтерпретаторі (ми бачили шматки по 200+ мс замість 1.5). Звичайні методи JIT компілює.
   */
  *build(
    obs: ObstacleSet,
    erosion: ErosionData,
    goalX: number,
    goalY: number,
    goalR: number,
    inflate: number,
  ): Job<NavFieldData> {
    this.out = this.buffers[this.back];
    this.minSd.fill(Infinity);
    this.pen.fill(0);
    for (let i = 0; i < obs.count; i++) {
      if (!obs.alive[i]) continue;
      this.rasterize(obs, i, inflate);
      if (overBudget()) yield;
    }
    this.finishRaster(inflate);
    if (overBudget()) yield;
    for (let k = 0; k < erosion.count; k += 512) {
      this.carveCraters(erosion, k, Math.min(erosion.count, k + 512), inflate);
      if (overBudget()) yield;
    }
    this.seedGoals(goalX, goalY, goalR);
    while (!this.thetaStep(256)) if (overBudget()) yield;
    this.maxDist = 0;
    for (let y = 0; y < this.size; y += 16) {
      this.directionRows(y, Math.min(this.size, y + 16));
      if (overBudget()) yield;
    }
    const out = this.out;
    out.maxDist = this.maxDist;
    this.back ^= 1;
    return out;
  }

  // --- 1. Растеризація: мінімальна знакова відстань до живої скелі в центрі кожної клітинки.
  private rasterize(obs: ObstacleSet, i: number, inflate: number): void {
    const { size, cellSize: cs, minSd, pen } = this;
    const cost = obs.navCost[i];
    if (cost < 0) return; // підставки зброї в поле не потрапляють
    const ox = obs.x[i];
    const oy = obs.y[i];
    const a = obs.a[i];
    const b = obs.b[i];
    const c0 = obs.cos[i];
    const s0 = obs.sin[i];
    const circle = obs.kind[i] === OBSTACLE_CIRCLE;
    const bound = circle ? a : Math.sqrt(a * a + b * b);
    const reach = bound + inflate + cs;
    const x0 = Math.max(0, Math.floor((ox - reach) / cs));
    const y0 = Math.max(0, Math.floor((oy - reach) / cs));
    const x1 = Math.min(size - 1, Math.floor((ox + reach) / cs));
    const y1 = Math.min(size - 1, Math.floor((oy + reach) / cs));
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const dx = (gx + 0.5) * cs - ox;
        const dy = (gy + 0.5) * cs - oy;
        let sd: number;
        if (circle) {
          sd = Math.sqrt(dx * dx + dy * dy) - a;
        } else {
          const qx = Math.abs(c0 * dx + s0 * dy) - a;
          const qy = Math.abs(-s0 * dx + c0 * dy) - b;
          const ex = qx > 0 ? qx : 0;
          const ey = qy > 0 ? qy : 0;
          sd = Math.sqrt(ex * ex + ey * ey) + Math.min(Math.max(qx, qy), 0);
        }
        const c = gy * size + gx;
        if (cost > 0) {
          if (sd < inflate && cost > pen[c]) pen[c] = cost;
        } else if (sd < minSd[c]) minSd[c] = sd;
      }
    }
  }

  private finishRaster(inflate: number): void {
    const { n, minSd, pen } = this;
    const blocked = this.out.blocked;
    let covered = 0;
    for (let c = 0; c < n; c++) {
      blocked[c] = minSd[c] < inflate ? 1 : pen[c] > 0 ? 2 : 0;
      if (minSd[c] < 0) covered++;
    }
    this.coverage = covered / n;
  }

  /**
   * Кратери ерозії відкривають клітинки скель. Клітинка вільна, якщо її центр досить глибоко в
   * кратері: до стінки кратера ≥ 0.6·inflate (у тунелі з кількох кратерів найближча стінка
   * далі, тож це консервативно лише для поодинокого кратера). Точні колізії — в ObstacleField.
   */
  private carveCraters(erosion: ErosionData, k0: number, k1: number, inflate: number): void {
    const { size, cellSize: cs } = this;
    const blocked = this.out.blocked;
    const margin = inflate * 0.6;
    for (let k = k0; k < k1; k++) {
      const room = erosion.r[k] - margin;
      if (room <= 0) continue;
      const cx = erosion.x[k];
      const cy = erosion.y[k];
      const x0 = Math.max(0, Math.floor((cx - room) / cs));
      const y0 = Math.max(0, Math.floor((cy - room) / cs));
      const x1 = Math.min(size - 1, Math.floor((cx + room) / cs));
      const y1 = Math.min(size - 1, Math.floor((cy + room) / cs));
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const c = gy * size + gx;
          if (blocked[c] !== 1) continue;
          const dx = (gx + 0.5) * cs - cx;
          const dy = (gy + 0.5) * cs - cy;
          if (dx * dx + dy * dy < room * room) blocked[c] = 0;
        }
      }
    }
  }

  // --- 2. Lazy Theta* від цілі (повне розгортання, без евристики — це «Dijkstra з any-angle»).
  // Координати — у клітинках; центр клітинки (gx+0.5, gy+0.5). parent = -1 — сама точка цілі.
  private seedGoals(goalX: number, goalY: number, goalR: number): void {
    const { size, cellSize: cs, parent, closed, heap } = this;
    const { blocked, dist } = this.out;
    const gX = goalX / cs;
    const gY = goalY / cs;
    this.gX = gX;
    this.gY = gY;
    dist.fill(Infinity);
    parent.fill(-2);
    closed.fill(0);
    this.gridParent.fill(0);
    heap.size = 0;
    const goalReach = goalR / cs + 1;
    this.goalReach2 = goalReach * goalReach;
    for (let gy = 0; gy < size; gy++) {
      for (let gx = 0; gx < size; gx++) {
        const dx = gx + 0.5 - gX;
        const dy = gy + 0.5 - gY;
        const d2 = dx * dx + dy * dy;
        if (d2 <= this.goalReach2) {
          const c = gy * size + gx;
          blocked[c] = 0;
          dist[c] = Math.sqrt(d2);
          parent[c] = -1;
          heap.push(Math.round(dist[c] * KEY_SCALE), c);
        }
      }
    }
  }

  /** Обробляє до `maxPops` вершин купи. true — пошук завершено. */
  private thetaStep(maxPops: number): boolean {
    const { size, parent, closed, heap, gX, gY, goalReach2, pen, gridParent } = this;
    const { blocked, dist } = this.out;
    for (let pops = 0; pops < maxPops; pops++) {
      if (heap.size === 0) return true;
      const key = heap.peekKey();
      const c = heap.pop();
      if (closed[c] || key > Math.round(dist[c] * KEY_SCALE)) continue; // застарілий запис
      const gx = c % size;
      const gy = (c / size) | 0;

      // «Лінива» перевірка: при релаксації ми припустили, що батька видно. Перевіряємо це
      // лише тепер, один раз на клітинку. Якщо ні — батьком стає найкращий закритий сусід.
      let p = parent[c];
      const sx = gx + 0.5 - gX;
      const sy = gy + 0.5 - gY;
      const isSeed = p === -1 && sx * sx + sy * sy <= goalReach2;
      if (!isSeed && gridParent[c] === 0 && !this.lineOfSight(blocked, p, c)) {
        let best = Infinity;
        for (let k = 0; k < 8; k++) {
          const nx = gx + NX[k];
          const ny = gy + NY[k];
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const nc = ny * size + nx;
          if (!closed[nc]) continue;
          if (k >= 4 && (blocked[gy * size + nx] || blocked[ny * size + gx])) continue;
          const g = dist[nc] + NCOST[k];
          if (g < best) {
            best = g;
            p = nc;
          }
        }
        parent[c] = p;
        dist[c] = best;
      }
      closed[c] = 1;

      // Релаксація: сусіда пропонуємо одразу батькові поточної клітинки (any-angle «зріз»).
      const px = p === -1 ? gX : (p % size) + 0.5;
      const py = p === -1 ? gY : ((p / size) | 0) + 0.5;
      const pd = p === -1 ? 0 : dist[p];
      for (let k = 0; k < 8; k++) {
        const nx = gx + NX[k];
        const ny = gy + NY[k];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const nc = ny * size + nx;
        const bn = blocked[nc];
        if (bn === 1 || closed[nc]) continue;
        // Не зрізаємо кути: діагональ можлива, лише якщо обидві ортогональні клітинки вільні
        // (і не будівлі — інакше шлях прослизав би крізь «драбинку» діагональної стіни).
        if (k >= 4 && (blocked[gy * size + nx] || blocked[ny * size + gx])) continue;
        if (bn === 2 || blocked[c] === 2) {
          // Крізь будівлю — лише грідом, з ціною входу.
          const nd = dist[c] + NCOST[k] + pen[nc];
          if (nd < dist[nc]) {
            dist[nc] = nd;
            parent[nc] = c;
            gridParent[nc] = 1;
            heap.push(Math.round(nd * KEY_SCALE), nc);
          }
          continue;
        }
        const ex = nx + 0.5 - px;
        const ey = ny + 0.5 - py;
        const nd = pd + Math.sqrt(ex * ex + ey * ey);
        if (nd < dist[nc]) {
          dist[nc] = nd;
          parent[nc] = p;
          gridParent[nc] = 0;
          heap.push(Math.round(nd * KEY_SCALE), nc);
        }
      }
    }
    return heap.size === 0;
  }

  // --- 3. Поле напрямків: від центру клітинки до батька. dist переводимо у світові одиниці.
  private directionRows(y0: number, y1: number): void {
    const { size, cellSize: cs, parent, gX, gY } = this;
    const { blocked, dist, dirX, dirY } = this.out;
    let maxDist = this.maxDist;
    for (let gy = y0; gy < y1; gy++) {
      for (let gx = 0; gx < size; gx++) {
        const c = gy * size + gx;
        dirX[c] = 0;
        dirY[c] = 0;
        if (blocked[c] === 1) continue; // (0,0): при білінійній інтерполяції такі клітинки не вносять внеску
        const p = parent[c];
        // Ізольована кишеня (недосяжно) або сама ціль: прямо до центру.
        const tx = p < 0 ? gX : (p % size) + 0.5;
        const ty = p < 0 ? gY : ((p / size) | 0) + 0.5;
        const vx = tx - (gx + 0.5);
        const vy = ty - (gy + 0.5);
        const len = Math.sqrt(vx * vx + vy * vy);
        if (len > 1e-9) {
          dirX[c] = vx / len;
          dirY[c] = vy / len;
        }
        if (dist[c] !== Infinity) {
          dist[c] *= cs;
          if (dist[c] > maxDist) maxDist = dist[c];
        }
      }
    }
    this.maxDist = maxDist;
  }

  /**
   * Пряма видимість від батька `p` (клітинка або ціль, якщо −1) до клітинки `c`: DDA-обхід усіх
   * клітинок, які перетинає відрізок (Amanatides–Woo). Якщо відрізок проходить точно через кут,
   * обидві клітинки, що його утворюють, мають бути вільні — щоб не «протискатися» між скелями.
   */
  private lineOfSight(blocked: Uint8Array, p: number, c: number): boolean {
    const size = this.size;
    const x0 = p === -1 ? this.gX : (p % size) + 0.5;
    const y0 = p === -1 ? this.gY : ((p / size) | 0) + 0.5;
    const x1 = (c % size) + 0.5;
    const y1 = ((c / size) | 0) + 0.5;
    let ix = Math.floor(x0);
    let iy = Math.floor(y0);
    const ex = Math.floor(x1);
    const ey = Math.floor(y1);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tMaxX = dx !== 0 ? (stepX > 0 ? ix + 1 - x0 : x0 - ix) * tDeltaX : Infinity;
    let tMaxY = dy !== 0 ? (stepY > 0 ? iy + 1 - y0 : y0 - iy) * tDeltaY : Infinity;
    // Скелі (1) перекривають видимість завжди; будівлі (2) — усі, крім стартової клітинки
    // (батько може бути клітинкою будівлі, з якої шлях щойно вийшов).
    for (let guard = 0; guard < size * 4; guard++) {
      const bc = blocked[iy * size + ix];
      if (bc === 1 || (bc === 2 && guard > 0)) return false;
      if (ix === ex && iy === ey) return true;
      if (Math.abs(tMaxX - tMaxY) < 1e-9) {
        if (blocked[iy * size + ix + stepX] || blocked[(iy + stepY) * size + ix]) return false;
        tMaxX += tDeltaX;
        tMaxY += tDeltaY;
        ix += stepX;
        iy += stepY;
      } else if (tMaxX < tMaxY) {
        tMaxX += tDeltaX;
        ix += stepX;
      } else {
        tMaxY += tDeltaY;
        iy += stepY;
      }
    }
    return true;
  }
}
