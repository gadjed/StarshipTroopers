export function compileProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`Shader compile error:\n${log}`);
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`Program link error:\n${gl.getProgramInfoLog(prog)}`);
  }
  return prog;
}

/** Збирає uniform locations один раз — у кадрі жодних getUniformLocation. */
export function uniforms<K extends string>(
  gl: WebGL2RenderingContext,
  prog: WebGLProgram,
  names: readonly K[],
): Record<K, WebGLUniformLocation | null> {
  const out = {} as Record<K, WebGLUniformLocation | null>;
  for (const n of names) out[n] = gl.getUniformLocation(prog, n);
  return out;
}

/**
 * GPU-таймер через EXT_disjoint_timer_query_webgl2 (є не в усіх браузерах/ОС).
 * Результати приходять із затримкою в кілька кадрів, тому тримаємо невеликий пул запитів.
 */
export class GpuTimer {
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private readonly free: WebGLQuery[] = [];
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  lastMs = -1;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  begin(): void {
    if (!this.ext || this.pending.length > 4) return;
    const q = this.free.pop() ?? this.gl.createQuery()!;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  poll(): void {
    if (!this.ext) return;
    const gl = this.gl;
    while (this.pending.length > 0) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
      if (!disjoint) this.lastMs = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      this.pending.shift();
      this.free.push(q);
    }
  }
}
