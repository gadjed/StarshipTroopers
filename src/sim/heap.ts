/**
 * Бінарна купа на typed arrays з ЦІЛИМИ ключами. Чому цілі: купа живе в іншому модулі й
 * викликається не інлайнено, а double-аргументи при такому виклику V8 пакує в HeapNumber —
 * перерахунок поля під час гри генерував би мегабайти сміття. Відстані квантуються
 * (× KEY_SCALE), точне значення зберігається поруч у Float32Array.
 */
export const KEY_SCALE = 64;

export class IntMinHeap {
  private readonly keys: Int32Array;
  private readonly vals: Int32Array;
  size = 0;

  constructor(capacity: number) {
    this.keys = new Int32Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  push(key: number, val: number): void {
    const keys = this.keys;
    const vals = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  peekKey(): number {
    return this.keys[0];
  }

  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0];
    const n = --this.size;
    const key = keys[n];
    const val = vals[n];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && keys[child + 1] < keys[child]) child++;
      if (keys[child] >= key) break;
      keys[i] = keys[child];
      vals[i] = vals[child];
      i = child;
    }
    keys[i] = key;
    vals[i] = val;
    return top;
  }
}
