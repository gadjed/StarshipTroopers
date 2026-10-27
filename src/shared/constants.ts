// Константи, які потрібні і симуляції, і рендеру. Жодних класів — лише дані.

export const WORLD_SIZE = 1000;
/** Ємність усіх буферів жуків. Пам'ять виділяється один раз на старті. */
export const MAX_BUGS = 200_000;

/**
 * Формат одного інстансу в буфері рендеру (Float32):
 *   [prevX, prevY, x, y, radius, type + shade*0.99]
 * prev/cur потрібні для інтерполяції між фіксованими кроками симуляції.
 * type і shade упаковані в один float: floor() = тип, fract() = відтінок.
 */
export const FLOATS_PER_BUG = 6;

export interface BugTypeDef {
  readonly name: string;
  readonly color: readonly [number, number, number];
  readonly radius: number;
  readonly speed: number;
  /** Відносна ймовірність появи. */
  readonly weight: number;
  /** Здоров'я (для укусів зараз і для зброї на наступних етапах). */
  readonly hp: number;
  /** Шкода за секунду дрібнішим сусідам у тісняві. */
  readonly bite: number;
  /** Шкода скелі за секунду, коли жук тисне на неї в тісняві (кислота, щелепи). */
  readonly corrode: number;
  /** Шкода будівлям гравця і бункеру за секунду контакту. */
  readonly attack: number;
}

export const BUG_TYPES: readonly BugTypeDef[] = [
  { name: 'ВОЇН', color: [0.36, 0.22, 0.13], radius: 1.0, speed: 22, weight: 0.5, hp: 10, bite: 0.6, corrode: 1, attack: 2 },
  { name: 'БІГУН', color: [0.95, 0.82, 0.32], radius: 0.75, speed: 32, weight: 0.25, hp: 5, bite: 0, corrode: 0.3, attack: 1 },
  { name: 'ТАНК', color: [0.72, 0.12, 0.1], radius: 1.5, speed: 13, weight: 0.1, hp: 40, bite: 3, corrode: 2.5, attack: 8 },
  { name: 'ПЛЮВАКА', color: [0.28, 0.58, 0.92], radius: 1.15, speed: 17, weight: 0.15, hp: 8, bite: 0.2, corrode: 6, attack: 4 },
  // Командир: не з'являється з вагою, а окремо (хвилі, таймер, клавіша K). Див. COMMANDER_*.
  { name: 'КОМАНДИР', color: [0.55, 0.12, 0.68], radius: 4.5, speed: 11, weight: 0, hp: 3000, bite: 0, corrode: 40, attack: 80 },
];

/** Звичайні типи — перші REGULAR_BUG_TYPES у BUG_TYPES; далі — командир. */
export const REGULAR_BUG_TYPES = 4;
export const COMMANDER_TYPE = 4;
/** Радіус аури командира: жуки в ній швидші й сильніше б'ють будівлі. */
export const COMMANDER_AURA = 30;
export const COMMANDER_SPEED_BUFF = 1.3;
export const COMMANDER_ATTACK_BUFF = 2;

export const BUG_RADIUS_JITTER = 0.1; // ±10 %
export const BUG_SPEED_JITTER = 0.15; // ±15 %
/**
 * Найбільший радіус звичайного жука — від нього залежать spatial hash і «роздування» nav-гріда.
 * Командир сюди не входить: його взаємодію з натовпом обробляє окрема груба сітка (simulation.ts).
 */
export const MAX_BUG_RADIUS = Math.max(...BUG_TYPES.slice(0, REGULAR_BUG_TYPES).map((t) => t.radius)) * (1 + BUG_RADIUS_JITTER);
export const COMMANDER_RADIUS = BUG_TYPES[COMMANDER_TYPE].radius;
