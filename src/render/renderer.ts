import { BUG_TYPES, FLOATS_PER_BUG, MAX_BUGS } from '../shared/constants';
import {
  OBSTACLE_STYLE_CORNER,
  OBSTACLE_STYLE_PAD,
  OBSTACLE_STYLE_ROCK,
  type BugFrame,
  type HashGridView,
  type MapData,
} from '../shared/contracts';
import { FX_FLOATS, MAX_FX_INSTANCES, type FxFrame } from '../shared/defense';
import type { Camera } from './camera';
import { GpuTimer, compileProgram, uniforms } from './glUtils';
import {
  BUG_FS,
  BUG_VS,
  ERODE_FS,
  ERODE_VS,
  FX_FS,
  FX_VS,
  GROUND_FS,
  GROUND_VS,
  OBSTACLE_FS,
  OBSTACLE_VS,
} from './shaders';

const OBSTACLE_FLOATS = 8; // x, y, sizeX, sizeY, cos, sin, kind, damage
// Вигляд перешкоди в шейдері (vKind): 0/1 — скеля, 2 — бункер, 3..5 — стіна (+підтримка), 6 — кут, 7 — підставка.
const BUNKER_KIND = 2;
const WALL_KIND = 3;
const CORNER_KIND = 6;
const PAD_KIND = 7;
/** Маска ерозії: ~0.5 м на тексель для світу 1000 м. */
const EROSION_TEX = 2048;
const MAX_CRATERS = 16384;
/** Маску перемальовуємо не частіше, ніж раз на стільки мс (кратери ростуть щокроку). */
const EROSION_REDRAW_MS = 60;

export interface DebugFlags {
  flow: boolean;
  grid: boolean;
}

/**
 * Рендер на сирому WebGL2. Знає лише про контракти з shared/ (MapData, BugFrame) —
 * жодних посилань на класи симуляції.
 *
 * Draw calls за кадр: земля (1) + тіні (1) + перешкоди (1) + FX під жуками (1) + жуки (1) +
 * FX над жуками (1), плюс перемальовування маски ерозії, коли кратери змінились.
 */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly gpuTimer: GpuTimer;
  private readonly canvas: HTMLCanvasElement;

  private readonly groundProg: WebGLProgram;
  private readonly groundU;
  private readonly emptyVao: WebGLVertexArrayObject;

  private readonly obstacleProg: WebGLProgram;
  private readonly obstacleU;
  private readonly obstacleVao: WebGLVertexArrayObject;
  private readonly obstacleBuf: WebGLBuffer;
  private obstacleCount = 0;
  private obstacleData = new Float32Array(0);
  private uploadedObstacleVersion = -1;
  private flowData = new Float32Array(0);
  private uploadedNavVersion = -1;

  private readonly bugProg: WebGLProgram;
  private readonly bugU;
  /**
   * Два буфери інстансів по черзі (ping-pong): пишемо в той, який GPU, найімовірніше,
   * вже не читає. Це прибирає можливу синхронізацію CPU↔GPU на bufferSubData.
   */
  private readonly bugBufs: WebGLBuffer[] = [];
  private readonly bugVaos: WebGLVertexArrayObject[] = [];
  private bugBufIndex = 0;
  private uploadedVersion = -1;
  private bugCount = 0;
  private readonly bugColors: Float32Array;

  private readonly erodeProg: WebGLProgram;
  private readonly erodeU;
  private readonly erodeVao: WebGLVertexArrayObject;
  private readonly craterBuf: WebGLBuffer;
  private readonly craterData = new Float32Array(MAX_CRATERS * 3);
  private readonly erosionTex: WebGLTexture;
  private readonly erosionFbo: WebGLFramebuffer;
  private drawnErosionVersion = -1;
  private lastErosionDraw = -Infinity;

  private readonly fxProg: WebGLProgram;
  private readonly fxU;
  private readonly fxVao: WebGLVertexArrayObject;
  private readonly fxBuf: WebGLBuffer;

  private flowTex: WebGLTexture | null = null;
  private heatTex: WebGLTexture | null = null;
  private heatBytes: Uint8Array | null = null;
  private heatW = 0;
  private heatH = 0;
  private map: MapData | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: false, // краї згладжуємо в шейдерах; MSAA тут лише витрачав би fill rate
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 недоступний');
    this.gl = gl;
    this.gpuTimer = new GpuTimer(gl);

    // --- Земля
    this.groundProg = compileProgram(gl, GROUND_VS, GROUND_FS);
    this.groundU = uniforms(gl, this.groundProg, [
      'uView', 'uViewport', 'uWorld', 'uShowFlow', 'uShowGrid', 'uFlow', 'uNavCell', 'uNavSize',
      'uHeat', 'uHashCell', 'uHashDim',
    ] as const);
    this.emptyVao = gl.createVertexArray()!;

    // Спільний квад [-1,1]² для інстансованих проходів (triangle strip).
    const cornerBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    // --- Перешкоди
    this.obstacleProg = compileProgram(gl, OBSTACLE_VS, OBSTACLE_FS);
    this.obstacleU = uniforms(gl, this.obstacleProg, ['uCam', 'uPx', 'uTime', 'uPass', 'uErosion', 'uWorld'] as const);
    this.obstacleVao = gl.createVertexArray()!;
    this.obstacleBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.obstacleVao);
    this.bindCorner(cornerBuf);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.obstacleBuf);
    const os = OBSTACLE_FLOATS * 4;
    this.instAttr(1, 2, os, 0);
    this.instAttr(2, 2, os, 8);
    this.instAttr(3, 2, os, 16);
    this.instAttr(4, 2, os, 24); // kind, damage

    // --- Жуки: буфери на повну ємність виділяються один раз.
    this.bugProg = compileProgram(gl, BUG_VS, BUG_FS);
    this.bugU = uniforms(gl, this.bugProg, ['uCam', 'uAlpha', 'uPx', 'uColors'] as const);
    const bs = FLOATS_PER_BUG * 4;
    for (let k = 0; k < 2; k++) {
      const vao = gl.createVertexArray()!;
      const buf = gl.createBuffer()!;
      gl.bindVertexArray(vao);
      this.bindCorner(cornerBuf);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, MAX_BUGS * bs, gl.DYNAMIC_DRAW);
      this.instAttr(1, 2, bs, 0);
      this.instAttr(2, 2, bs, 8);
      this.instAttr(3, 2, bs, 16);
      this.bugVaos.push(vao);
      this.bugBufs.push(buf);
    }
    // --- Маска ерозії скель (R8, рендер-таргет).
    this.erodeProg = compileProgram(gl, ERODE_VS, ERODE_FS);
    this.erodeU = uniforms(gl, this.erodeProg, ['uWorld'] as const);
    this.erodeVao = gl.createVertexArray()!;
    this.craterBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.erodeVao);
    this.bindCorner(cornerBuf);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.craterBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.craterData.byteLength, gl.DYNAMIC_DRAW);
    this.instAttr(1, 3, 12, 0);
    this.erosionTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.erosionTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, EROSION_TEX, EROSION_TEX, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.erosionFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.erosionFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.erosionTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // --- Оборона й ефекти: один буфер на кадр, два draw calls (під жуками і над ними).
    this.fxProg = compileProgram(gl, FX_VS, FX_FS);
    this.fxU = uniforms(gl, this.fxProg, ['uCam', 'uAlpha', 'uPx', 'uTime'] as const);
    this.fxVao = gl.createVertexArray()!;
    this.fxBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.fxVao);
    this.bindCorner(cornerBuf);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fxBuf);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_FX_INSTANCES * FX_FLOATS * 4, gl.DYNAMIC_DRAW);
    this.instAttr(1, 4, FX_FLOATS * 4, 0);
    this.instAttr(2, 4, FX_FLOATS * 4, 16);
    gl.bindVertexArray(null);

    this.bugColors = new Float32Array(BUG_TYPES.length * 3);
    BUG_TYPES.forEach((t, i) => this.bugColors.set(t.color, i * 3));

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha
  }

  private bindCorner(buf: WebGLBuffer): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  private instAttr(loc: number, size: number, stride: number, offset: number): void {
    const gl = this.gl;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    gl.vertexAttribDivisor(loc, 1);
  }

  private fxOffset(instance: number): void {
    const gl = this.gl;
    const stride = FX_FLOATS * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fxBuf);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, instance * stride);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, instance * stride + 16);
  }

  /** Розміри канвасу у фізичних пікселях. Повертає true, якщо змінились. */
  resize(): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
  }

  /** Завантажує статичні дані мапи (раз на мапу). */
  /** Нова мапа. Буфери скель і поля далі оновлюються самі, коли змінюються версії в MapData. */
  setMap(map: MapData): void {
    const gl = this.gl;
    this.map = map;
    // Ємність — з запасом під будівлі гравця (kind.length, а не count).
    this.obstacleData = new Float32Array((map.obstacles.kind.length + 1) * OBSTACLE_FLOATS);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.obstacleBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.obstacleData.byteLength, gl.DYNAMIC_DRAW);
    this.uploadedObstacleVersion = -1;

    const n = map.nav.size;
    if (!this.flowTex || this.flowData.length !== n * n * 4) {
      if (this.flowTex) gl.deleteTexture(this.flowTex);
      this.flowTex = gl.createTexture()!;
      this.flowData = new Float32Array(n * n * 4);
      gl.bindTexture(gl.TEXTURE_2D, this.flowTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, n, 0, gl.RGBA, gl.FLOAT, null);
      this.nearest();
    }
    this.uploadedNavVersion = -1;
    this.drawnErosionVersion = -1;
  }

  /** Перемальовує маску ерозії з усіх кратерів (blend MAX), не частіше EROSION_REDRAW_MS. */
  private syncErosion(map: MapData, nowMs: number): void {
    const er = map.erosion;
    if (er.version === this.drawnErosionVersion) return;
    if (this.drawnErosionVersion >= 0 && nowMs - this.lastErosionDraw < EROSION_REDRAW_MS) return;
    this.drawnErosionVersion = er.version;
    this.lastErosionDraw = nowMs;
    const gl = this.gl;
    const n = Math.min(er.count, MAX_CRATERS);
    const d = this.craterData;
    for (let k = 0; k < n; k++) {
      d[k * 3] = er.x[k];
      d[k * 3 + 1] = er.y[k];
      d[k * 3 + 2] = er.r[k];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.erosionFbo);
    gl.viewport(0, 0, EROSION_TEX, EROSION_TEX);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (n > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.craterBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, n * 3);
      gl.useProgram(this.erodeProg);
      gl.uniform1f(this.erodeU.uWorld, map.worldSize);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(this.erodeVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Скелі змінюються (корозія) — перезаливаємо їхній невеликий буфер, лише коли змінилась версія. */
  private syncObstacles(map: MapData): void {
    if (map.obstacleVersion === this.uploadedObstacleVersion) return;
    this.uploadedObstacleVersion = map.obstacleVersion;
    const obs = map.obstacles;
    const data = this.obstacleData;
    let o = 0;
    for (let i = 0; i < obs.count; i++) {
      if (!obs.alive[i]) continue; // зруйновані не малюємо
      data[o] = obs.x[i];
      data[o + 1] = obs.y[i];
      data[o + 2] = obs.a[i];
      data[o + 3] = obs.b[i];
      data[o + 4] = obs.cos[i];
      data[o + 5] = obs.sin[i];
      const st = obs.style[i];
      data[o + 6] =
        st === OBSTACLE_STYLE_ROCK ? obs.kind[i] : st === OBSTACLE_STYLE_CORNER ? CORNER_KIND : st === OBSTACLE_STYLE_PAD ? PAD_KIND : WALL_KIND + st - 1;
      data[o + 7] = obs.damage[i];
      o += OBSTACLE_FLOATS;
    }
    const b = map.bunker;
    data[o] = b.x;
    data[o + 1] = b.y;
    data[o + 2] = b.r;
    data[o + 3] = b.r;
    data[o + 4] = 1;
    data[o + 5] = 0;
    data[o + 6] = BUNKER_KIND;
    data[o + 7] = 0;
    o += OBSTACLE_FLOATS;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.obstacleBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, o);
    this.obstacleCount = o / OBSTACLE_FLOATS;
  }

  /** Flow field → RGBA32F текстура для оверлею; перезаливається після кожної перебудови поля. */
  private syncFlow(map: MapData): void {
    if (map.navVersion === this.uploadedNavVersion) return;
    this.uploadedNavVersion = map.navVersion;
    const nav = map.nav;
    const n = nav.size * nav.size;
    const tex = this.flowData;
    for (let c = 0; c < n; c++) {
      tex[c * 4] = nav.dirX[c];
      tex[c * 4 + 1] = nav.dirY[c];
      tex[c * 4 + 2] = nav.blocked[c];
      tex[c * 4 + 3] = nav.dist[c] !== Infinity ? nav.dist[c] : -1;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.flowTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, nav.size, nav.size, gl.RGBA, gl.FLOAT, tex);
  }

  private nearest(): void {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private uploadHeat(hash: HashGridView): void {
    const gl = this.gl;
    if (!this.heatTex || this.heatW !== hash.w || this.heatH !== hash.h) {
      if (this.heatTex) gl.deleteTexture(this.heatTex);
      this.heatTex = gl.createTexture()!;
      this.heatW = hash.w;
      this.heatH = hash.h;
      this.heatBytes = new Uint8Array(hash.w * hash.h);
      gl.bindTexture(gl.TEXTURE_2D, this.heatTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, hash.w, hash.h, 0, gl.RED, gl.UNSIGNED_BYTE, this.heatBytes);
      this.nearest();
    }
    const bytes = this.heatBytes!;
    const counts = hash.counts;
    // ~8 жуків у клітинці = максимум шкали.
    for (let c = 0; c < bytes.length; c++) {
      const v = counts[c] * 32;
      bytes[c] = v > 255 ? 255 : v;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.heatTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, hash.w, hash.h, gl.RED, gl.UNSIGNED_BYTE, bytes);
  }

  render(
    cam: Camera,
    frame: BugFrame,
    alpha: number,
    debug: DebugFlags,
    hash: HashGridView,
    timeSec: number,
    fx: FxFrame,
  ): void {
    const gl = this.gl;
    const map = this.map;
    if (!map) return;
    this.gpuTimer.poll();
    this.gpuTimer.begin();
    this.syncObstacles(map);
    this.syncErosion(map, timeSec * 1000);
    if (debug.flow) this.syncFlow(map);

    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    const px = 1 / cam.zoom;
    const sx = (2 * cam.zoom) / w;
    const sy = (-2 * cam.zoom) / h;

    // --- 1. Земля + оверлеї (без блендингу — вона перезаписує весь кадр, clear не потрібен)
    gl.disable(gl.BLEND);
    gl.useProgram(this.groundProg);
    const gu = this.groundU;
    gl.uniform4f(gu.uView, cam.x, cam.y, px, h);
    gl.uniform2f(gu.uViewport, w, h);
    gl.uniform1f(gu.uWorld, map.worldSize);
    gl.uniform1i(gu.uShowFlow, debug.flow ? 1 : 0);
    gl.uniform1i(gu.uShowGrid, debug.grid ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.flowTex);
    gl.uniform1i(gu.uFlow, 0);
    gl.uniform1f(gu.uNavCell, map.nav.cellSize);
    gl.uniform1i(gu.uNavSize, map.nav.size);
    if (debug.grid) this.uploadHeat(hash);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.heatTex);
    gl.uniform1i(gu.uHeat, 1);
    gl.uniform1f(gu.uHashCell, hash.cellSize);
    gl.uniform2i(gu.uHashDim, hash.w, hash.h);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND);

    // --- 2. Тіні, потім скелі й бункер
    gl.useProgram(this.obstacleProg);
    const ou = this.obstacleU;
    gl.uniform4f(ou.uCam, cam.x, cam.y, sx, sy);
    gl.uniform1f(ou.uPx, px);
    gl.uniform1f(ou.uTime, timeSec);
    gl.uniform1f(ou.uWorld, map.worldSize);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.erosionTex);
    gl.uniform1i(ou.uErosion, 2);
    gl.bindVertexArray(this.obstacleVao);
    gl.uniform1i(ou.uPass, 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.obstacleCount);
    gl.uniform1i(ou.uPass, 1);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.obstacleCount);

    // --- 3. FX під жуками (робочі зони, міни). Буфер FX перепаковується щокадру.
    const fu = this.fxU;
    if (fx.count > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fxBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, fx.instances, 0, fx.count * FX_FLOATS);
      gl.useProgram(this.fxProg);
      gl.uniform4f(fu.uCam, cam.x, cam.y, sx, sy);
      gl.uniform1f(fu.uAlpha, alpha);
      gl.uniform1f(fu.uPx, px);
      gl.uniform1f(fu.uTime, timeSec);
      gl.bindVertexArray(this.fxVao);
      this.fxOffset(0);
      if (fx.under > 0) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, fx.under);
    }

    // --- 4. Жуки: один upload (лише якщо симуляція зробила крок) + один draw call.
    if (frame.version !== this.uploadedVersion) {
      this.bugBufIndex ^= 1;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bugBufs[this.bugBufIndex]);
      if (frame.count > 0) {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, frame.instances, 0, frame.count * FLOATS_PER_BUG);
      }
      this.uploadedVersion = frame.version;
      this.bugCount = frame.count;
    }
    if (this.bugCount > 0) {
      gl.useProgram(this.bugProg);
      const bu = this.bugU;
      gl.uniform4f(bu.uCam, cam.x, cam.y, sx, sy);
      gl.uniform1f(bu.uAlpha, alpha);
      gl.uniform1f(bu.uPx, px);
      gl.uniform3fv(bu.uColors, this.bugColors);
      gl.bindVertexArray(this.bugVaos[this.bugBufIndex]);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.bugCount);
    }

    // --- 5. FX над жуками: стволи, снаряди, вогонь, вибухи, блискавки, привиди будівництва.
    if (fx.count > fx.under) {
      gl.useProgram(this.fxProg);
      gl.uniform4f(fu.uCam, cam.x, cam.y, sx, sy);
      gl.uniform1f(fu.uAlpha, alpha);
      gl.uniform1f(fu.uPx, px);
      gl.uniform1f(fu.uTime, timeSec);
      gl.bindVertexArray(this.fxVao);
      // У WebGL2 немає «base instance» — зсуваємо атрибути інстансу на початок верхнього шару.
      this.fxOffset(fx.under);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, fx.count - fx.under);
    }
    gl.bindVertexArray(null);
    this.gpuTimer.end();
  }
}
