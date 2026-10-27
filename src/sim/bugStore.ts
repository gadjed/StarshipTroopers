/**
 * Стан усіх жуків у форматі Structure-of-Arrays + пул вільних слотів.
 *
 * Індекс жука — стабільний ідентифікатор слота: поки жук живий, його індекс
 * не змінюється (це знадобиться для турелей, що «тримають» ціль).
 *
 * Усі масиви — view в один ArrayBuffer (або SharedArrayBuffer), виділений один раз.
 * Щоб перенести симуляцію у Worker, досить передати `buffer` і відтворити view
 * з тими самими зсувами.
 */
export class BugStore {
  readonly capacity: number;
  readonly buffer: ArrayBufferLike;

  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly velX: Float32Array;
  readonly velY: Float32Array;
  /** Позиція на початку останнього кроку — для інтерполяції в рендері. */
  readonly prevX: Float32Array;
  readonly prevY: Float32Array;
  readonly radius: Float32Array;
  readonly maxSpeed: Float32Array;
  /** Варіація відтінку кольору [0, 1). */
  readonly shade: Float32Array;
  /** Найменша досягнута відстань до цілі за полем (для виявлення «застрягання»). */
  readonly bestDist: Float32Array;
  /** Скільки секунд жук не наближається до цілі. */
  readonly stuckTime: Float32Array;
  /** Скільки секунд ще триває відхід убік (0 — звичайний рух). */
  readonly detourTime: Float32Array;
  readonly freeStack: Int32Array;
  readonly type: Uint8Array;
  readonly alive: Uint8Array;
  /** Здоров'я (укуси зараз, зброя на наступних етапах). */
  readonly hp: Float32Array;
  /** Бік відходу: −1 / +1. */
  readonly detourSide: Int8Array;
  /**
   * 1 — жук у тісняві біля скелі й застряг, тож кусає дрібніших (рішення з попереднього кроку).
   * Один байт замість читання тиску й часу застрягання в проході пар — там це були б дві
   * розкидані вибірки на кожного жука.
   */
  readonly biteReady: Uint8Array;

  /** Кількість елементів у freeStack. */
  freeTop = 0;
  aliveCount = 0;
  /** Усі живі жуки мають індекс < highWater. Цикли йдуть до highWater, а не до capacity. */
  highWater = 0;

  constructor(capacity: number, shared: boolean) {
    this.capacity = capacity;
    const f32Arrays = 13;
    const i32Arrays = 1;
    const u8Arrays = 4;
    const bytes = capacity * 4 * (f32Arrays + i32Arrays) + capacity * u8Arrays;
    this.buffer = shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);

    // 4-байтові масиви йдуть першими, щоб зсуви були вирівняні.
    let offset = 0;
    const f32 = () => {
      const a = new Float32Array(this.buffer, offset, capacity);
      offset += capacity * 4;
      return a;
    };
    this.posX = f32();
    this.posY = f32();
    this.velX = f32();
    this.velY = f32();
    this.prevX = f32();
    this.prevY = f32();
    this.radius = f32();
    this.maxSpeed = f32();
    this.shade = f32();
    this.bestDist = f32();
    this.stuckTime = f32();
    this.detourTime = f32();
    this.hp = f32();
    this.freeStack = new Int32Array(this.buffer, offset, capacity);
    offset += capacity * 4;
    this.type = new Uint8Array(this.buffer, offset, capacity);
    offset += capacity;
    this.alive = new Uint8Array(this.buffer, offset, capacity);
    offset += capacity;
    this.detourSide = new Int8Array(this.buffer, offset, capacity);
    offset += capacity;
    this.biteReady = new Uint8Array(this.buffer, offset, capacity);

    this.reset();
  }

  /** Вбиває всіх і відновлює пул. */
  reset(): void {
    this.alive.fill(0);
    const cap = this.capacity;
    // Кладемо індекси у зворотному порядку, щоб першими видавались 0, 1, 2…
    // Тоді живі жуки займають щільний префікс і highWater лишається малим.
    for (let i = 0; i < cap; i++) this.freeStack[i] = cap - 1 - i;
    this.freeTop = cap;
    this.aliveCount = 0;
    this.highWater = 0;
  }

  /** O(1). Повертає індекс слота або -1, якщо пул вичерпано. */
  allocate(): number {
    if (this.freeTop === 0) return -1;
    const i = this.freeStack[--this.freeTop];
    this.alive[i] = 1;
    this.aliveCount++;
    if (i >= this.highWater) this.highWater = i + 1;
    return i;
  }

  /** O(1) амортизовано. Безпечно викликати для вже мертвого слота. */
  free(i: number): void {
    const alive = this.alive;
    if (alive[i] === 0) return;
    alive[i] = 0;
    this.freeStack[this.freeTop++] = i;
    this.aliveCount--;
    // Підтягуємо highWater вниз, якщо звільнили верхній слот.
    // Кожен крок циклу «оплачено» раніше виданим слотом → амортизовано O(1).
    let hw = this.highWater;
    while (hw > 0 && alive[hw - 1] === 0) hw--;
    this.highWater = hw;
  }
}
