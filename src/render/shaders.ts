// GLSL ES 3.00. Камера передається як uCam = (centerX, centerY, scaleX, scaleY):
// clip = (world - center) * scale, де scaleY < 0 (світова Y дивиться вниз).

const NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s;
}
`;

// ---------------------------------------------------------------------------
// Земля + налагоджувальні оверлеї (flow field, spatial hash) — один fullscreen-трикутник.
// Оверлеї малюються процедурно у фрагментному шейдері з текстур, без вершинних буферів зі стрілками.

export const GROUND_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const GROUND_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform vec4 uView;        // centerX, centerY, worldPerPx, viewH
uniform vec2 uViewport;
uniform float uWorld;
uniform int uShowFlow;
uniform int uShowGrid;
uniform sampler2D uFlow;   // RGBA32F: dirX, dirY, blocked, dist
uniform float uNavCell;
uniform int uNavSize;
uniform sampler2D uHeat;   // R8: заповненість клітинок spatial hash
uniform float uHashCell;
uniform ivec2 uHashDim;
out vec4 outColor;
${NOISE}

float gridLine(vec2 w, float step, float px) {
  vec2 g = abs(fract(w / step - 0.5) - 0.5) * step;
  return 1.0 - smoothstep(0.0, px * 1.2, min(g.x, g.y));
}

void main() {
  float px = uView.z;
  vec2 w = vec2(uView.x + (gl_FragCoord.x - uViewport.x * 0.5) * px,
                uView.y - (gl_FragCoord.y - uViewport.y * 0.5) * px);
  bool inside = w.x >= 0.0 && w.y >= 0.0 && w.x < uWorld && w.y < uWorld;

  // Пісок пустелі: велике fbm + дюни + дрібна текстура.
  float n = fbm(w * 0.011);
  float n2 = fbm(w * 0.07 + 7.0);
  float dunes = sin(w.x * 0.045 + w.y * 0.018 + n * 7.0) * 0.5 + 0.5;
  vec3 sandDark = vec3(0.56, 0.30, 0.13);
  vec3 sand = vec3(0.80, 0.47, 0.22);
  vec3 sandLight = vec3(0.93, 0.64, 0.34);
  vec3 col = mix(sandDark, sand, smoothstep(0.25, 0.75, n));
  col = mix(col, sandLight, dunes * 0.35 * smoothstep(0.3, 0.8, n2));
  col *= 0.94 + 0.12 * n2;

  // Тактична сітка кожні 100 одиниць.
  col = mix(col, col * 0.62, gridLine(w, 100.0, px) * 0.55);

  if (!inside) {
    col = mix(vec3(0.05, 0.035, 0.02), col * 0.25, 0.5);
  } else {
    // Темна рамка спавн-зони біля країв.
    float edge = min(min(w.x, w.y), min(uWorld - w.x, uWorld - w.y));
    col *= mix(0.82, 1.0, smoothstep(0.0, 30.0, edge));

    if (uShowFlow == 1) {
      ivec2 c = clamp(ivec2(w / uNavCell), ivec2(0), ivec2(uNavSize - 1));
      vec4 f = texelFetch(uFlow, c, 0);
      if (f.z > 0.5) {
        col = mix(col, vec3(0.75, 0.08, 0.06), 0.45);
      } else {
        // Смуги рівної відстані з integration field.
        if (f.w >= 0.0) col = mix(col, vec3(0.2, 1.0, 0.5), 0.10 * step(0.5, fract(f.w / 40.0)));
        // Стрілка в кожній клітинці (SDF у локальних координатах клітинки).
        float cellPx = uNavCell / px;
        float vis = smoothstep(5.0, 11.0, cellPx);
        if (vis > 0.0 && dot(f.xy, f.xy) > 0.0) {
          vec2 l = fract(w / uNavCell) - 0.5;
          float u = dot(l, f.xy);
          float v = dot(l, vec2(-f.y, f.x));
          float aa = 1.0 / cellPx;
          float shaft = (1.0 - smoothstep(0.045, 0.045 + aa, abs(v))) *
                        step(-0.36, u) * step(u, 0.12);
          float head = (1.0 - smoothstep(0.0, aa, abs(v) - (0.40 - u) * 0.75)) *
                       step(0.05, u) * step(u, 0.40);
          col = mix(col, vec3(0.25, 1.0, 0.45), max(shaft, head) * vis * 0.85);
        }
      }
    }

    if (uShowGrid == 1) {
      ivec2 c = clamp(ivec2(w / uHashCell), ivec2(0), uHashDim - 1);
      float h = texelFetch(uHeat, c, 0).r;
      if (h > 0.0) {
        vec3 heat = mix(vec3(0.1, 0.9, 0.3), vec3(1.0, 0.85, 0.1), smoothstep(0.0, 0.5, h));
        heat = mix(heat, vec3(1.0, 0.15, 0.1), smoothstep(0.5, 1.0, h));
        col = mix(col, heat, 0.45);
      }
      float vis = smoothstep(3.0, 8.0, uHashCell / px);
      col = mix(col, vec3(0.1, 1.0, 0.4), gridLine(w, uHashCell, px) * vis * 0.5);
    }
  }
  outColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// Скелі, бункер і будівлі-перешкоди: інстансовані квади, форма — SDF у фрагментному шейдері.
// Два проходи (uPass): 0 — тіні всіх перешкод, 1 — самі перешкоди (щоб тіні не лягали на скелі).
// vKind: 0/1 — скеля (коло/прямокутник), 2 — бункер, 3/4/5 — стіна без кутів / з одним / з двома,
// 6 — кут, 7 — підставка зброї. Ерозію скель (кратери) беремо з маски uErosion.

export const OBSTACLE_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec2 iPos;
layout(location = 2) in vec2 iSize;
layout(location = 3) in vec2 iRot;
layout(location = 4) in vec2 iKindDamage;
uniform vec4 uCam;
out vec2 vLocal;
out vec2 vWorld;
out vec2 vShadow;
flat out vec2 vSize;
flat out vec2 vRot;
flat out float vKind;
flat out float vDamage;
const float PAD = 8.0;
void main() {
  vec2 local = aCorner * (iSize + PAD);
  vec2 world = iPos + vec2(iRot.x * local.x - iRot.y * local.y, iRot.y * local.x + iRot.x * local.y);
  vec2 so = vec2(3.0, 4.0); // зсув тіні у світі (світло зверху-зліва)
  vShadow = vec2(iRot.x * so.x + iRot.y * so.y, -iRot.y * so.x + iRot.x * so.y);
  vLocal = local;
  vWorld = world;
  vSize = iSize;
  vRot = iRot;
  vKind = iKindDamage.x;
  vDamage = iKindDamage.y;
  gl_Position = vec4((world - uCam.xy) * uCam.zw, 0.0, 1.0);
}`;

export const OBSTACLE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vWorld;
in vec2 vShadow;
flat in vec2 vSize;
flat in vec2 vRot;
flat in float vKind;
flat in float vDamage;
uniform float uPx;
uniform float uTime;
uniform int uPass;
uniform sampler2D uErosion; // R8: 1 — вигризено (кратер), м'який край ~1.6 м назовні
uniform float uWorld;
out vec4 outColor;
${NOISE}

float erosionAt(vec2 w) { return texture(uErosion, w / uWorld).r; }

float sdShape(vec2 p) {
  if ((vKind > 0.5 && vKind < 1.5) || (vKind > 2.5 && vKind < 6.5)) {
    vec2 q = abs(p) - vSize;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  }
  return length(p) - vSize.x;
}

void main() {
  float aa = uPx * 1.2;
  if (uPass == 0) {
    float ds = sdShape(vLocal - vShadow);
    float a = (1.0 - smoothstep(-3.0, 5.0, ds)) * 0.42;
    // Тінь скелі «дірява» там, де її вигризли (джерело тіні зсунуте на (3, 4) у світі).
    if (vKind < 1.5) a *= 1.0 - smoothstep(0.6, 0.97, erosionAt(vWorld - vec2(3.0, 4.0)));
    if (a < 0.004) discard;
    outColor = vec4(0.0, 0.0, 0.0, a);
    return;
  }
  float d = sdShape(vLocal);

  if (vKind > 1.5 && vKind < 2.5) {
    // Бункер: бетонний диск, люк, блимаючий маячок і зелена хвиля-пінг навколо.
    float r = length(vLocal);
    vec3 c = vec3(0.46, 0.48, 0.46) * (0.88 + 0.12 * vnoise(vWorld * 1.3));
    c = mix(c, vec3(0.22, 0.24, 0.23), 1.0 - smoothstep(0.4, 0.9, abs(d + 4.0)));
    c = mix(c, vec3(0.16, 0.18, 0.17), step(max(abs(vLocal.x), abs(vLocal.y)), 4.5));
    float blink = step(0.5, fract(uTime * 1.2));
    c = mix(c, vec3(0.35, 1.0, 0.55), (1.0 - smoothstep(1.2, 1.8, r)) * blink);
    c = mix(c, vec3(0.08), smoothstep(-1.2, -0.2, d) * 0.8);
    float a = 1.0 - smoothstep(-aa, aa, d);
    float pr = mod(uTime * 5.0, 8.0);
    float ring = (1.0 - smoothstep(0.0, 0.6 + aa, abs(d - pr))) * (1.0 - pr / 8.0) * (1.0 - a);
    vec3 col = c * a + vec3(0.25, 1.0, 0.45) * ring * 0.8;
    float alpha = a + ring * 0.8;
    if (alpha < 0.003) discard;
    outColor = vec4(col, alpha);
    return;
  }

  float a = 1.0 - smoothstep(-aa, aa, d);
  if (a <= 0.0) discard;

  if (vKind > 2.5) {
    // --- Будівлі гравця.
    vec3 c;
    vec3 edgeCol = vec3(0.12, 0.12, 0.11);
    float edgeW = 0.45;
    if (vKind > 6.5) {
      // Підставка зброї: бетон + жовто-чорне попереджувальне кільце.
      c = vec3(0.44, 0.45, 0.42) * (0.88 + 0.14 * vnoise(vWorld * 2.0));
      float ang = atan(vLocal.y, vLocal.x);
      float stripe = step(0.5, fract(ang * 12.0 / 6.2831853));
      float ring = step(-1.1, d) * step(d, -0.35);
      c = mix(c, mix(vec3(0.08), vec3(0.85, 0.66, 0.12), stripe), ring);
    } else if (vKind > 5.5) {
      // Кут: сталевий блок із заклепками та діагоналями.
      c = vec3(0.26, 0.29, 0.29) * (0.9 + 0.1 * vnoise(vWorld * 3.0));
      vec2 q = abs(vLocal) - vSize * 0.62;
      float rivet = 1.0 - smoothstep(0.25, 0.25 + aa, length(q));
      float diag = 1.0 - smoothstep(0.1, 0.1 + aa, min(abs(vLocal.x - vLocal.y), abs(vLocal.x + vLocal.y)) * 0.7071);
      c = mix(c, vec3(0.55, 0.58, 0.56), rivet * 0.9);
      c = mix(c, c * 0.6, diag * 0.7);
      c *= 1.0 + 0.35 * (1.0 - smoothstep(0.0, 0.7, -d));
    } else {
      // Стіна: бетонні плити зі швами кожні 4 м. Підтримка кутами — кольором краю
      // (бурштиновий — один кут, зелений — обидва).
      c = vec3(0.60, 0.59, 0.55) * (0.88 + 0.16 * vnoise(vWorld * 1.6));
      float seam = 1.0 - smoothstep(0.05, 0.05 + aa, abs(fract(vLocal.x / 4.0) - 0.5) * 4.0 - 1.85);
      c *= 1.0 - seam * 0.35;
      c *= 1.0 + 0.25 * smoothstep(0.0, vSize.y, vLocal.y * -1.0); // верхня грань світліша
      if (vKind > 4.5) { edgeCol = vec3(0.25, 0.95, 0.45); edgeW = 0.4; }
      else if (vKind > 3.5) { edgeCol = vec3(0.95, 0.65, 0.15); edgeW = 0.4; }
    }
    // Пошкодження: тріщини й потемніння (будівля не зменшується — тріскається й падає при 0).
    if (vDamage > 0.0) {
      float crack = abs(vnoise(vWorld * 0.9 + 11.0) - 0.5) + abs(vnoise(vWorld * 2.3) - 0.5) * 0.5;
      c *= 1.0 - (1.0 - smoothstep(0.0, 0.06 * vDamage + 0.005, crack)) * 0.75;
      c *= 1.0 - vDamage * 0.35;
    }
    c = mix(c, edgeCol, smoothstep(-edgeW - aa, -edgeW + aa, d));
    outColor = vec4(c * a, a);
    return;
  }

  // --- Скеля. Кратери ерозії — дірки в матеріалі з кислотною облямівкою навколо.
  float er = erosionAt(vWorld);
  float hole = smoothstep(0.85, 0.97, er);
  a *= 1.0 - hole;
  if (a <= 0.003) discard;
  // Нормаль краю з чисельного градієнта SDF, переведена у світові координати.
  float e = 0.35;
  vec2 g = vec2(sdShape(vLocal + vec2(e, 0.0)) - sdShape(vLocal - vec2(e, 0.0)),
                sdShape(vLocal + vec2(0.0, e)) - sdShape(vLocal - vec2(0.0, e)));
  g = dot(g, g) > 1e-8 ? normalize(g) : vec2(0.0);
  vec2 gw = vec2(vRot.x * g.x - vRot.y * g.y, vRot.y * g.x + vRot.x * g.y);
  float lit = dot(gw, normalize(vec2(-0.6, -0.8)));
  float bevel = 1.0 - clamp(-d / 5.0, 0.0, 1.0);

  float n = fbm(vWorld * 0.16);
  vec3 base = mix(vec3(0.30, 0.22, 0.17), vec3(0.55, 0.43, 0.33), n);
  base *= 0.88 + 0.24 * vnoise(vWorld * 0.9);
  base *= 1.0 + bevel * 0.6 * lit;
  float crack = abs(vnoise(vWorld * 0.22 + 3.0) - 0.5);
  base *= 0.78 + 0.22 * smoothstep(0.0, 0.05, crack);
  base = mix(base, vec3(0.11, 0.07, 0.05), smoothstep(-1.4, -0.2, d) * 0.85);
  // Корозія лише там, де вигризли: кислотна пляма навколо кратера і темний обвал його краю.
  if (er > 0.01) {
    vec3 acid = mix(vec3(0.16, 0.22, 0.04), vec3(0.50, 0.70, 0.10), vnoise(vWorld * 2.0 + uTime * 0.4));
    float stain = smoothstep(0.02, 0.55, er + (vnoise(vWorld * 1.7) - 0.5) * 0.25);
    base = mix(base, acid, stain * 0.8);
    base *= 1.0 - 0.55 * smoothstep(0.55, 0.9, er);
    base += vec3(0.40, 0.65, 0.05) * (1.0 - smoothstep(0.0, 0.1, abs(er - 0.8))) * 0.5;
  }
  outColor = vec4(base * a, a);
}`;

// ---------------------------------------------------------------------------
// Жуки: один instanced draw call. Кожен — billboard-квад, «куля» малюється у фрагментному шейдері
// (нормаль сфери з uv, дифуз + блік + темна обвідка). Позиція інтерполюється між кроками симуляції.

export const BUG_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec2 iPrev;
layout(location = 2) in vec2 iCur;
layout(location = 3) in vec2 iRadType; // radius, type + shade
uniform vec4 uCam;
uniform float uAlpha;
uniform float uPx;
uniform vec3 uColors[5];
out vec2 vUv;
flat out vec3 vColor;
flat out float vAA;
void main() {
  vec2 p = mix(iPrev, iCur, uAlpha);
  // Мінімум ~1 px радіуса, щоб при віддаленні жуки не зникали.
  float r = max(iRadType.x, uPx * 1.0);
  float t = floor(iRadType.y);
  float shade = iRadType.y - t;
  vColor = uColors[int(t)] * (0.82 + 0.36 * shade);
  vAA = clamp(uPx / r * 1.5, 0.02, 1.0);
  vUv = aCorner;
  gl_Position = vec4((p + aCorner * r - uCam.xy) * uCam.zw, 0.0, 1.0);
}`;

export const BUG_FS = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vUv;
flat in vec3 vColor;
flat in float vAA;
out vec4 outColor;
const vec3 L = vec3(-0.42, -0.55, 0.72); // нормалізовано заздалегідь; -y = «вгору» на екрані
void main() {
  float d2 = dot(vUv, vUv);
  if (d2 > 1.0) discard;
  float d = sqrt(d2);
  float a = 1.0 - smoothstep(1.0 - vAA, 1.0, d);
  vec3 n = vec3(vUv, sqrt(1.0 - d2));
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 18.0);
  vec3 c = vColor * (0.25 + 0.95 * diff) + spec * 0.4;
  c = mix(c, vColor * 0.15, smoothstep(0.72, 0.94, d) * 0.85);
  outColor = vec4(c * a, a);
}`;

// ---------------------------------------------------------------------------
// Маска ерозії: кратери (x, y, r) малюються в R8-текстуру світу з blend MAX.
// 1 — вигризено; від краю кратера назовні значення плавно спадає (кислотна облямівка в шейдері скель).

export const ERODE_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 iCrater;
uniform float uWorld;
out vec2 vP;
flat out float vR;
void main() {
  float ext = iCrater.z + 2.0;
  vP = aCorner * ext;
  vR = iCrater.z;
  vec2 w = iCrater.xy + vP;
  gl_Position = vec4(w / uWorld * 2.0 - 1.0, 0.0, 1.0);
}`;

export const ERODE_FS = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vP;
flat in float vR;
out vec4 outColor;
void main() {
  float v = 1.0 - smoothstep(vR, vR + 1.6, length(vP));
  outColor = vec4(v, 0.0, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// Оборона й ефекти: один інстансований прохід, вигляд за kind (див. FX_* у shared/defense.ts).
// Диски: центр a (снаряди 0–2 — інтерполяція a→b), b — додаткові параметри. Відрізки (kind ≥ 20): a→b.

export const FX_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iA;
layout(location = 2) in vec4 iB; // size, kind, t, extra
uniform vec4 uCam;
uniform float uAlpha;
uniform float uPx;
out vec2 vLocal;
out vec2 vWorld;
flat out float vKind;
flat out float vT;
flat out float vExtra;
flat out float vSize;
flat out float vLen;
flat out vec2 vAux;
void main() {
  float size = iB.x;
  float kind = iB.y;
  vKind = kind;
  vT = iB.z;
  vExtra = iB.w;
  vSize = size;
  vec2 world;
  if (kind >= 19.5) {
    vec2 a = iA.xy;
    vec2 d = iA.zw - a;
    float len = length(d);
    vec2 u = len > 1e-4 ? d / len : vec2(1.0, 0.0);
    vec2 n = vec2(-u.y, u.x);
    float w = size * 3.0 + uPx * 2.0 + (kind > 20.5 && kind < 21.5 ? 2.5 : 0.0);
    float along = mix(-w, len + w, aCorner.x * 0.5 + 0.5);
    float across = aCorner.y * w;
    world = a + u * along + n * across;
    vLocal = vec2(along, across);
    vLen = len;
    vAux = vec2(0.0);
  } else {
    vec2 c = kind < 2.5 ? mix(iA.xy, iA.zw, uAlpha) : iA.xy;
    vAux = iA.zw;
    float ext = size * 1.6 + uPx * 2.0;
    if (kind > 7.5 && kind < 8.5) ext = size * 3.2 + uPx * 2.0;
    else if (kind > 0.5 && kind < 1.5) ext = size * 2.5 + iB.w + 2.0;
    else if (kind > 8.5 && kind < 9.5) ext = size + uPx * 3.0;
    else if (kind > 6.5 && kind < 7.5) ext = 72.0;
    else if (kind > 15.5) ext = size + 1.0;
    vLocal = aCorner * ext;
    world = c + vLocal;
    vLen = 0.0;
  }
  vWorld = world;
  gl_Position = vec4((world - uCam.xy) * uCam.zw, 0.0, 1.0);
}`;

export const FX_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vWorld;
flat in float vKind;
flat in float vT;
flat in float vExtra;
flat in float vSize;
flat in float vLen;
flat in vec2 vAux;
uniform float uPx;
uniform float uTime;
out vec4 outColor;
${NOISE}
const float PI = 3.14159265;

float fill(float d) { return 1.0 - smoothstep(-uPx, uPx, d); }
float sdBox(vec2 p, vec2 b) { vec2 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); }
vec3 okBad(float v) { return v > 1.5 ? vec3(1.0, 0.25, 0.15) : vec3(0.3, 1.0, 0.55); }

// Голова зброї: ствол уздовж +x локальних координат (q). Повертає SDF; tip — кінчик ствола.
float sdHead(vec2 q, int type, float s, out float tip) {
  float hr = 0.55 * s;
  float bar;
  if (type == 0) { // турель: спарені стволи
    tip = 1.55 * s;
    bar = min(sdBox(q - vec2(tip * 0.5, 0.38), vec2(tip * 0.5, 0.17)), sdBox(q - vec2(tip * 0.5, -0.38), vec2(tip * 0.5, 0.17)));
  } else if (type == 1) { // гармата: довгий товстий ствол з дульним гальмом
    hr = 0.62 * s;
    tip = 2.1 * s;
    bar = min(sdBox(q - vec2(tip * 0.5, 0.0), vec2(tip * 0.5, 0.42)), sdBox(q - vec2(tip - 0.6, 0.0), vec2(0.6, 0.7)));
  } else if (type == 2) { // міномет: коротка широка труба
    hr = 0.65 * s;
    tip = 1.0 * s;
    bar = sdBox(q - vec2(tip * 0.5, 0.0), vec2(tip * 0.5, 0.75));
  } else if (type == 3) { // вогнемет: сопло + два балони позаду
    hr = 0.5 * s;
    tip = 1.4 * s;
    bar = min(sdBox(q - vec2(tip * 0.5, 0.0), vec2(tip * 0.5, 0.3)),
              min(length(q - vec2(-0.45 * s, 0.5 * s)) - 0.32 * s, length(q - vec2(-0.45 * s, -0.5 * s)) - 0.32 * s));
  } else { // електро: котушка й два електроди
    hr = 0.5 * s;
    tip = 1.1 * s;
    bar = min(sdBox(q - vec2(tip * 0.55, 0.45), vec2(tip * 0.45, 0.14)), sdBox(q - vec2(tip * 0.55, -0.45), vec2(tip * 0.45, 0.14)));
  }
  return min(length(q) - hr, bar);
}

void main() {
  int k = int(vKind + 0.5);
  vec2 p = vLocal;
  float r = length(p);
  float s = vSize;
  vec4 c = vec4(0.0);

  if (k == 0) { // фугас гармати
    float core = fill(r - s * 0.55);
    float glow = exp(-r * r / (s * s * 1.5));
    c = vec4(vec3(1.0, 0.85, 0.5) * core + vec3(1.0, 0.5, 0.1) * glow * 0.6, core + glow * 0.2);
  } else if (k == 1) { // мінометна міна: тінь на землі + снаряд на висоті дуги
    float h = sin(PI * clamp(vT, 0.0, 1.0)) * vExtra;
    float sh = (1.0 - smoothstep(s * 0.4, s * 1.5, r)) * 0.4;
    float scale = 1.0 + h / 35.0;
    vec2 q = p - vec2(0.0, -h);
    float rr = length(q);
    float ball = fill(rr - s * scale);
    vec3 bc = mix(vec3(0.2, 0.22, 0.18), vec3(0.62, 0.64, 0.56), clamp(-q.y / (s * scale) * 0.5 + 0.5, 0.0, 1.0));
    float glow = exp(-rr * rr / (s * s * scale * scale * 4.0)) * 0.3;
    c = vec4(0.0, 0.0, 0.0, sh);
    c = c * (1.0 - ball) + vec4(bc * ball, ball);
    c.rgb += vec3(1.0, 0.4, 0.1) * glow;
  } else if (k == 2) { // крапля вогню в польоті
    float rad = s * (0.5 + 0.9 * vT);
    float n = vnoise(vWorld * 0.8 + vec2(vExtra * 13.0, -uTime * 6.0));
    float a = (1.0 - smoothstep(rad * 0.3, rad * (0.8 + 0.4 * n), r)) * (1.0 - vT * 0.5);
    vec3 col = mix(vec3(1.0, 0.95, 0.6), vec3(1.0, 0.35, 0.05), clamp(r / rad + vT * 0.5, 0.0, 1.0));
    c = vec4(col * a, a * 0.6);
  } else if (k == 3) { // зона вогню
    float life = clamp(vT, 0.0, 1.0);
    float fade = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.7, 1.0, life));
    float n = fbm(vWorld * 0.45 + vec2(vExtra * 7.0, uTime * 2.5));
    float edge = 1.0 - smoothstep(s * 0.5, s * (0.95 + 0.25 * n), r);
    float flame = edge * smoothstep(0.3, 0.75, n + 0.25 * (1.0 - r / s));
    vec3 col = mix(vec3(0.9, 0.2, 0.02), vec3(1.0, 0.85, 0.3), smoothstep(0.45, 0.9, n));
    float a = flame * fade;
    c = vec4(col * a, a * 0.75 + edge * fade * 0.12);
  } else if (k == 4) { // вибух: спалах, ударне кільце, дим
    float t = clamp(vT, 0.0, 1.0);
    float flash = (1.0 - smoothstep(0.0, 0.35, t)) * (1.0 - smoothstep(s * 0.2, s * (0.4 + 0.6 * t), r));
    float ringR = s * (0.25 + 0.85 * sqrt(t));
    float ring = (1.0 - smoothstep(0.0, s * 0.1 + uPx, abs(r - ringR))) * (1.0 - t);
    float n = vnoise(vWorld * 0.4 + vExtra);
    float smoke = (1.0 - smoothstep(s * 0.3, s * (0.7 + 0.3 * n), r)) * smoothstep(0.1, 0.4, t) * (1.0 - t) * 0.55;
    float fa = clamp(flash + ring * 0.7, 0.0, 1.0);
    vec3 fc = vec3(1.0, 0.9, 0.6) * flash + vec3(1.0, 0.55, 0.15) * ring * 0.7;
    c = vec4(fc + vec3(0.08, 0.06, 0.05) * smoke * (1.0 - fa), fa + smoke * (1.0 - fa));
  } else if (k == 5 && vT >= 2.0) { // спрацьована міна: випалена ямка + дуга прогресу перезарядки
    float prog = vT - 2.0;
    float scorch = (1.0 - smoothstep(s * 0.4, s * 1.8, r)) * 0.45;
    float ang = atan(p.x, -p.y);
    float frac = (ang < 0.0 ? ang + 2.0 * PI : ang) / (2.0 * PI);
    float arc = fill(abs(r - s * 0.9) - 0.12) * step(frac, prog);
    vec3 col = vec3(0.3, 1.0, 0.5) * arc * 0.7;
    c = vec4(col, scorch * (1.0 - arc) + arc * 0.7);
  } else if (k == 5) { // міна (vT = 1 — зведена, блимає червоним)
    float body = fill(r - s);
    float rim = fill(abs(r - s * 0.75) - 0.12);
    float armed = step(0.5, vT);
    float blink = armed > 0.5 ? step(0.5, fract(uTime * 8.0)) : step(0.85, fract(uTime * 0.8 + vExtra));
    vec3 light = armed > 0.5 ? vec3(1.0, 0.15, 0.1) : vec3(0.3, 1.0, 0.5);
    vec3 col = mix(vec3(0.17, 0.19, 0.15), vec3(0.34, 0.36, 0.3), rim);
    col = mix(col, light, fill(r - s * 0.3) * blink);
    c = vec4(col * body, body);
  } else if (k == 6) { // мітка орбітального удару
    float ang = atan(p.y, p.x);
    float dash = step(0.5, fract(ang * 6.0 / PI + uTime * 0.6));
    float ring = fill(abs(r - s) - 0.45) * dash;
    float inner = fill(abs(r - s * (1.0 - clamp(vT, 0.0, 1.0))) - 0.3);
    float cross = (fill(abs(p.x) - 0.25) + fill(abs(p.y) - 0.25)) * step(r, 4.0);
    float a = clamp(ring + inner * 0.7 + cross + (1.0 - smoothstep(0.0, s, r)) * 0.08, 0.0, 1.0);
    a *= 0.6 + 0.4 * step(0.5, fract(uTime * 3.0));
    c = vec4(vec3(1.0, 0.2, 0.1) * a, a * 0.9);
  } else if (k == 7) { // орбітальний снаряд, що падає (vT: 0 → 1 — удар)
    float t = clamp(vT, 0.0, 1.0);
    vec2 dir = normalize(vec2(-0.35, -1.0));
    vec2 head = dir * (1.0 - t) * 65.0;
    vec2 ba = dir * 14.0;
    vec2 pa = p - head;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    float d = length(pa - ba * h);
    float streak = (1.0 - smoothstep(0.0, 0.8 + uPx, d)) * (1.0 - h);
    float glowHead = exp(-dot(p - head, p - head) / 6.0);
    float target = fill(abs(r - s * (0.6 + (1.0 - t) * 1.5)) - 0.25) * 0.8;
    vec3 col = vec3(1.0, 0.9, 0.7) * streak + vec3(1.0, 0.5, 0.2) * glowHead + vec3(1.0, 0.25, 0.1) * target;
    c = vec4(col, clamp(streak + glowHead * 0.5 + target, 0.0, 1.0) * 0.9);
  } else if (k == 8) { // голова зброї; vT — тип, vExtra — кут, vAux = (спалах, міцність | −1/−2 — привид)
    int type = int(vT + 0.5);
    float ca = cos(vExtra);
    float sa = sin(vExtra);
    vec2 q = vec2(ca * p.x + sa * p.y, -sa * p.x + ca * p.y);
    float tip;
    float d = sdHead(q, type, s, tip);
    float a = fill(d);
    vec3 base = type == 4 ? vec3(0.28, 0.32, 0.38) : type == 3 ? vec3(0.38, 0.30, 0.22) : vec3(0.30, 0.35, 0.26);
    float lit = clamp(0.5 - dot(p / max(s, 1e-3), vec2(-0.6, -0.8)) * -0.5, 0.0, 1.0);
    vec3 col = base * (0.75 + 0.5 * lit);
    col = mix(col, vec3(0.06, 0.07, 0.05), smoothstep(-0.35 - uPx, -0.35 + uPx, d));
    if (type == 4) {
      float coil = fill(abs(r - s * 0.32) - 0.12) * fill(r - s * 0.5);
      col = mix(col, vec3(0.5, 0.75, 1.0), coil * (0.6 + 0.4 * sin(uTime * 9.0)));
    }
    if (vAux.y >= 0.0) col = mix(col, vec3(0.45, 0.08, 0.04), (1.0 - vAux.y) * 0.45);
    float flash = vAux.x * (1.0 - smoothstep(0.0, 1.2 * (type == 1 ? 1.8 : 1.0), length(q - vec2(tip + 0.6, 0.0))));
    vec3 fcol = type == 3 ? vec3(1.0, 0.55, 0.1) : type == 4 ? vec3(0.6, 0.85, 1.0) : vec3(1.0, 0.9, 0.5);
    if (vAux.y < 0.0) {
      vec3 g = okBad(-vAux.y);
      c = vec4(g * a * 0.55, a * 0.55);
    } else {
      c = vec4(col * a + fcol * flash, max(a, flash));
    }
  } else if (k == 9) { // робоча зона: vSize — дальність, vAux = (мін. дальність, режим), vT — пів-кута, vExtra — напрямок
    float ang = atan(p.y, p.x);
    float da = abs(mod(ang - vExtra + PI, 2.0 * PI) - PI);
    float lw = uPx * 1.2;
    float inR = step(r, s) * step(vAux.x, r);
    float inA = step(da, vT);
    float arc = (1.0 - smoothstep(lw * 0.5, lw * 1.5, abs(r - s))) * inA;
    float arc2 = vAux.x > 0.0 ? (1.0 - smoothstep(lw * 0.5, lw * 1.5, abs(r - vAux.x))) * inA : 0.0;
    float radial = (1.0 - smoothstep(lw * 0.5, lw * 1.5, abs(r * sin(da - vT)))) * step(abs(da - vT), 0.5) * inR;
    float mode = vAux.y;
    vec3 col = mode > 1.5 ? vec3(1.0, 0.25, 0.15) : vec3(0.3, 1.0, 0.55);
    float fillA = mode > 0.5 ? 0.12 : 0.04;
    float lineA = mode > 0.5 ? 0.85 : 0.3;
    float a = inR * inA * fillA + max(max(arc, arc2), radial) * lineA;
    c = vec4(col * a, a);
  } else if (k == 10) { // іскра (рикошет об скелю, розряд у землю)
    float t = clamp(vT, 0.0, 1.0);
    float a = (1.0 - smoothstep(0.0, s * (0.4 + t), r)) * (1.0 - t);
    c = vec4(vec3(1.0, 0.85, 0.5) * a, a * 0.5);
  } else if (k == 14) { // привид будівлі (vT: 1 — можна, 2 — не можна), vExtra: 0 — коло, 1 — квадрат
    float d = vExtra > 0.5 ? sdBox(p, vec2(s)) : r - s;
    float a = fill(d) * 0.35 + fill(abs(d) - uPx * 1.2) * 0.8;
    c = vec4(okBad(vT) * a, a);
  } else if (k == 15) { // міцність ядра — дуга навколо бункера
    float ang = atan(p.x, -p.y);
    float frac = (ang < 0.0 ? ang + 2.0 * PI : ang) / (2.0 * PI);
    float band = fill(abs(r - s) - 0.7);
    float on = step(frac, vT);
    vec3 col = mix(vec3(1.0, 0.2, 0.1), vec3(0.3, 1.0, 0.5), smoothstep(0.2, 0.6, vT));
    float a = band * (on * 0.9 + (1.0 - on) * 0.25);
    c = vec4(mix(vec3(0.2, 0.05, 0.03), col, on) * a, a);
  } else if (k == 16) { // смужка міцності будівлі
    float f = fill(sdBox(p, vec2(s, 0.45)));
    float x01 = (p.x + s) / (2.0 * s);
    vec3 col = x01 <= vT ? mix(vec3(1.0, 0.25, 0.1), vec3(0.3, 1.0, 0.5), smoothstep(0.25, 0.7, vT)) : vec3(0.08, 0.1, 0.08);
    c = vec4(col * f * 0.9, f * 0.9);
  } else if (k == 17) { // командир: аура (vSize) і пульсуюче сяйво навколо тіла; vAux = (радіус тіла, міцність)
    float ang = atan(p.y, p.x);
    float dash = step(0.5, fract(ang * 8.0 / PI - uTime * 0.4));
    float ring = fill(abs(r - s) - 0.35) * dash * 0.55;
    float pulse = 0.5 + 0.5 * sin(uTime * 4.0);
    float halo = (1.0 - smoothstep(vAux.x, vAux.x + 2.0 + pulse * 1.5, r)) * step(vAux.x * 0.9, r);
    float area = (1.0 - smoothstep(0.0, s, r)) * 0.06;
    vec3 col = vec3(0.85, 0.2, 1.0);
    float a = ring + halo * 0.7 + area;
    c = vec4(col * a, a * 0.8);
  } else if (k == 20) { // трасер кулі
    float inSeg = step(0.0, p.x) * step(p.x, vLen);
    float hd = clamp(p.x / max(vLen, 1e-3), 0.0, 1.0);
    float core = (1.0 - smoothstep(s * 0.5, s + uPx, abs(p.y))) * inSeg * hd;
    c = vec4(vec3(1.0, 0.9, 0.55) * core, core * 0.8);
  } else if (k == 21) { // блискавка
    float along = clamp(p.x, 0.0, vLen);
    float env = sin(PI * along / max(vLen, 1e-3));
    float fr = floor(uTime * 30.0);
    float off = (vnoise(vec2(along * 0.35, vExtra * 17.0 + fr)) - 0.5) * 4.0 * env
              + (vnoise(vec2(along * 1.3, vExtra * 5.0 + fr * 1.7)) - 0.5) * 1.2 * env;
    float d = abs(p.y - off);
    float inSeg = step(-0.5, p.x) * step(p.x, vLen + 0.5);
    float core = (1.0 - smoothstep(s * 0.3, s * 0.6 + uPx, d)) * inSeg;
    float glow = exp(-d * d / (s * s * 6.0)) * inSeg;
    float fade = 1.0 - clamp(vT, 0.0, 1.0);
    vec3 col = vec3(0.85, 0.95, 1.0) * core + vec3(0.3, 0.55, 1.0) * glow * 0.8;
    c = vec4(col * fade, (core + glow * 0.3) * fade);
  } else if (k == 22) { // привид стіни
    float d = sdBox(vec2(p.x - vLen * 0.5, p.y), vec2(vLen * 0.5, s));
    float a = fill(d) * 0.35 + fill(abs(d) - uPx * 1.2) * 0.8;
    c = vec4(okBad(vT) * a, a);
  }
  if (c.a < 0.003 && c.r + c.g + c.b < 0.003) discard;
  outColor = c;
}`;
