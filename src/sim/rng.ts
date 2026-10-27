/** Mulberry32: швидкий детермінований PRNG. Повертає float у [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Той самий генератор, але повертає ціле в [0, 2^30) — воно лізе в Smi, тож при неінлайненому
 * виклику не пакується в HeapNumber (як float із mulberry32). Множити на RNG_INV30 — на місці.
 */
export const RNG_INV30 = 1 / 1073741824;
export function mulberry32Int(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 2;
  };
}

export function randomSeed(): number {
  return (Math.random() * 0x7fffffff) | 0;
}
