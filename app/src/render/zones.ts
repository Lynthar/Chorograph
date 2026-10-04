/* 气候分区的渲染输入（GL 与 CPU 同式）：分区栅格 → 各档权重（一热编码按过渡宽度模糊）+ 每档观感表；
   逐像素按权重混各档的**结果**（色阶颜色、林线淡出、雪盖），不混参数。纬度改正只给未涂那一档（[0]）。 */
import { CLIMATE, CLIMATE_ORDER } from "../core/constants.ts";
import { elevUnitM } from "../core/elev.ts";
import type { ZoneField } from "../core/climzone.ts";
import type { BBox, Climate, Meta } from "../core/types.ts";
import { CLIM_STOPS, FX, climLook, climRampColor, rampColor, snowSpec } from "./material.ts";

/** 档数：[0]＝未涂（meta.climate 那一档，可为出厂），1..6＝CLIMATE_ORDER */
export const ZONE_N = 1 + CLIMATE_ORDER.length;
/** 档界过渡宽度（公里）：边界两侧权重自 10% 到 90% 的距离 */
export const ZONE_BLEND_KM = 80;

/** id＝换代序号（GL 跳帧指纹与 CPU 瓦片判「权重换了」用） */
export interface ZoneWeights { id: number; bb: BBox; pd: number; cols: number; rows: number; w: Float32Array; tex0: Uint8Array; tex1: Uint8Array }
let wSeq = 0;

/* 权重按 ZoneField 对象记忆（栅格换代即换对象）；另留上一份：同几何同参数时只重算栅格变了的那片——笔刷每帧整幅模糊要 10–15 ms */
const wMemo = new WeakMap<ZoneField, { k: string; W: ZoneWeights }>();
let lastW: { z: Uint8Array; k: string; W: ZoneWeights } | null = null;

/** 分区 → 各档权重：w[(j·cols+i)·ZONE_N + k]，每格和为 1；tex0/tex1 是 GL 的两张 RGBA8（档 0..3 / 4..6）。增量与整幅逐位相同 */
export function zoneWeights(f: ZoneField, kmPerDeg: number, km = ZONE_BLEND_KM): ZoneWeights {
  const { cols, rows } = f, n = cols * rows, k = `${kmPerDeg}|${km}|${cols}x${rows}|${f.pd}|${f.bb.lonMin},${f.bb.latMin}`, hit = wMemo.get(f);
  if (hit && hit.k === k) return hit.W;
  const sigma = km / 2.56 / (f.pd * kmPerDeg);   // 阶跃过高斯：10%→90% 宽≈2.56σ
  const R = sigma > 0.3 ? Math.ceil(3 * sigma) : 0, ker = new Float32Array(2 * R + 1);
  let s = 0;
  for (let t = -R; t <= R; t++) s += ker[t + R] = R ? Math.exp(-t * t / (2 * sigma * sigma)) : 1;
  for (let t = 0; t < ker.length; t++) ker[t] /= s;
  const L = lastW && lastW.k === k ? lastW : null, box = L ? diffBox(L.z, f.z, cols, rows) : undefined;
  let W: ZoneWeights;
  if (L && box === null) W = L.W;
  else if (L && box && (box[2] - box[0] + 1 + 2 * R) * (box[3] - box[1] + 1 + 2 * R) < n / 4) {
    const O = [Math.max(0, box[0] - R), Math.max(0, box[1] - R), Math.min(cols - 1, box[2] + R), Math.min(rows - 1, box[3] + R)];
    W = { ...L.W, id: ++wSeq, w: L.W.w.slice(), tex0: L.W.tex0.slice(), tex1: L.W.tex1.slice() };
    blurInto(f.z, cols, rows, ker, R, W.w, O, Array.from({ length: ZONE_N }, (_, c) => c));
    packInto(W, O);
  } else {
    const present = [...new Set(f.z)];
    W = { id: ++wSeq, bb: f.bb, pd: f.pd, cols, rows, w: new Float32Array(n * ZONE_N), tex0: new Uint8Array(n * 4), tex1: new Uint8Array(n * 4) };
    const all = [0, 0, cols - 1, rows - 1];
    blurInto(f.z, cols, rows, ker, R, W.w, all, present);
    packInto(W, all);
  }
  wMemo.set(f, { k, W });
  lastW = { z: f.z, k, W };
  return W;
}
/** 两份栅格不同处的外接矩形 [c0, r0, c1, r1]；相同＝null */
function diffBox(a: Uint8Array, b: Uint8Array, cols: number, rows: number): number[] | null {
  let c0 = cols, r0 = rows, c1 = -1, r1 = -1;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) if (a[j * cols + i] !== b[j * cols + i]) {
    if (i < c0) c0 = i; if (i > c1) c1 = i; if (j < r0) r0 = j; r1 = j;
  }
  return c1 < 0 ? null : [c0, r0, c1, r1];
}
/** 矩形 O 内各档权重＝一热编码的可分离高斯（边缘沿用边格，同纹理 CLAMP_TO_EDGE）；只写 chans 列出的档 */
function blurInto(z: Uint8Array, cols: number, rows: number, ker: Float32Array, R: number, w: Float32Array, O: number[], chans: number[]): void {
  const [x0, y0, x1, y1] = O, ow = x1 - x0 + 1, ty0 = Math.max(0, y0 - R), ty1 = Math.min(rows - 1, y1 + R), tmp = new Float32Array(ow * (ty1 - ty0 + 1));
  for (const c of chans) {
    for (let j = ty0; j <= ty1; j++) for (let i = x0; i <= x1; i++) {
      let a = 0;
      for (let t = -R; t <= R; t++) if (z[j * cols + Math.max(0, Math.min(cols - 1, i + t))] === c) a += ker[t + R];
      tmp[(j - ty0) * ow + i - x0] = a;
    }
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      let a = 0;
      for (let t = -R; t <= R; t++) a += ker[t + R] * tmp[(Math.max(0, Math.min(rows - 1, j + t)) - ty0) * ow + i - x0];
      w[(j * cols + i) * ZONE_N + c] = a;
    }
  }
}
function packInto(W: ZoneWeights, O: number[]): void {
  for (let j = O[1]; j <= O[3]; j++) for (let i = O[0]; i <= O[2]; i++) {
    const q = j * W.cols + i;
    for (let c = 0; c < ZONE_N; c++) {
      const v = Math.round(W.w[q * ZONE_N + c] * 255);
      if (c < 4) W.tex0[q * 4 + c] = v; else W.tex1[q * 4 + c - 4] = v;
    }
  }
}

/** 某点的各档权重（双线性、出界沿用边格；同 GL 的 LINEAR + CLAMP_TO_EDGE）写进 out，返回 out */
export function zoneWeightsAt(Z: ZoneWeights, lon: number, lat: number, out: Float32Array): Float32Array {
  const fx = Math.max(0, Math.min(Z.cols - 1, (lon - Z.bb.lonMin) / Z.pd - 0.5)), fy = Math.max(0, Math.min(Z.rows - 1, (lat - Z.bb.latMin) / Z.pd - 0.5));
  const c0 = Math.floor(fx), r0 = Math.floor(fy), c1 = Math.min(Z.cols - 1, c0 + 1), r1 = Math.min(Z.rows - 1, r0 + 1), tx = fx - c0, ty = fy - r0;
  const a = (r0 * Z.cols + c0) * ZONE_N, b = (r0 * Z.cols + c1) * ZONE_N, c = (r1 * Z.cols + c0) * ZONE_N, d = (r1 * Z.cols + c1) * ZONE_N, w = Z.w;
  for (let k = 0; k < ZONE_N; k++)
    out[k] = (w[a + k] * (1 - tx) + w[b + k] * tx) * (1 - ty) + (w[c + k] * (1 - tx) + w[d + k] * tx) * ty;
  return out;
}

/** 每档观感：n=0＝沿用出厂色阶；tree＝有林线；snow＝雪线抽象高程；meadow 为 0..255 */
export interface ZoneLook { n: number; ramp: Float32Array; tree: boolean; treeE: number; band: number; meadow: readonly [number, number, number]; snow: number }
export interface ZoneLooks { L: ZoneLook[]; key: string }

let looksMemo: ZoneLooks | null = null;
/** [0]＝meta.climate 那一档（climLook/snowSpec 原样，球面图随纬度改正）；1..6 每档不随纬度（分区本身即作者对气候的声明）。按 key 单槽记忆（帧循环每帧调） */
export function zoneLooks(meta: Meta | undefined): ZoneLooks {
  const U = elevUnitM(meta), s0 = snowSpec(meta), m = meta || {};
  const key = JSON.stringify([m.climate ?? "", U, m.mapKind ?? "", s0]);
  if (looksMemo && looksMemo.key === key) return looksMemo;
  const of = (c: Climate | undefined, snow: number): ZoneLook => {
    const L = c ? climLook({ ...m, climate: c }) : climLook(meta);
    return L ? { n: L.n, ramp: L.ramp, tree: true, treeE: L.treeE, band: L.band, meadow: L.meadow, snow }
      : { n: 0, ramp: new Float32Array(CLIM_STOPS * 4), tree: false, treeE: 0, band: 1, meadow: [0, 0, 0], snow };
  };
  const L = [of(undefined, s0.base), ...CLIMATE_ORDER.map(c => of(c, CLIMATE[c].snowM / U))];
  return looksMemo = { L, key };
}

/** GL 的观感表（RGBA32F，宽 ZLOOK_W、高 ZONE_N）：每档一行，0..7 色阶段，8＝(段数, 林线, 淡出带, 雪线)，9＝(草甸色 0..1, 有林线) */
export const ZLOOK_W = CLIM_STOPS + 2;
export function zoneLookTexels(Z: ZoneLooks): Float32Array {
  const t = new Float32Array(ZLOOK_W * ZONE_N * 4);
  Z.L.forEach((L, k) => {
    const o = k * ZLOOK_W * 4;
    t.set(L.ramp, o);
    t.set([L.n, L.treeE, L.band, L.snow], o + CLIM_STOPS * 4);
    t.set([L.meadow[0] / 255, L.meadow[1] / 255, L.meadow[2] / 255, L.tree ? 1 : 0], o + CLIM_STOPS * 4 + 4);
  });
  return t;
}

/** 权重低于它的档不算（省逐像素循环；最多丢千分之二的权重） */
const W_EPS = 0.002;
const sstep = (a: number, b: number, x: number): number => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** 林线淡出与草甸色（CPU；GL 的 zoneTree 同式）：ecd＝未扭曲点的双线性画面场高程，dl＝未涂那一档的纬度改正。out＝[淡出, r, g, b(0..255)] */
export function zoneTreeMix(Z: ZoneLooks, w: Float32Array, ecd: number, dl: number, out: Float32Array): Float32Array {
  let f = 0, r = 0, g = 0, b = 0;
  for (let k = 0; k < ZONE_N; k++) {
    const L = Z.L[k];
    if (w[k] < W_EPS || !L.tree) continue;
    const d = k === 0 ? dl : 0, t = w[k] * sstep(L.treeE + d, L.treeE + d + L.band, ecd);
    f += t; r += t * L.meadow[0]; g += t * L.meadow[1]; b += t * L.meadow[2];
  }
  out[0] = f;
  if (f > 1e-5) { out[1] = r / f; out[2] = g / f; out[3] = b / f; } else out[1] = out[2] = out[3] = 0;
  return out;
}

/** 陆地色与雪盖（CPU；GL 的 zoneCol 同式）：雪盖未乘陡坡折扣。out＝[r, g, b(0..255), 雪盖] */
export function zoneColMix(Z: ZoneLooks, w: Float32Array, e: number, dl: number, beach: boolean, out: Float32Array): Float32Array {
  let r = 0, g = 0, b = 0, s = 0, ws = 0;
  for (let k = 0; k < ZONE_N; k++) {
    if (w[k] < W_EPS) continue;
    const L = Z.L[k], d = k === 0 ? dl : 0, c = L.n > 0 ? climRampColor(L, e, d) : rampColor(e, beach), snE = Math.max(0, L.snow + d);
    r += w[k] * c[0]; g += w[k] * c[1]; b += w[k] * c[2]; s += w[k] * sstep(snE, snE + FX.snowBand, e); ws += w[k];
  }
  out[0] = r / ws; out[1] = g / ws; out[2] = b / ws; out[3] = s / ws;
  return out;
}

/** 上面两个函数的 GLSL 同式（读 uZW0/uZW1/uZLook/uZoneBB；须排在 elevLand/elevLow 之后） */
export function zoneGLSL(): string {
  return `float zw[${ZONE_N}];
void zoneW(vec2 ll){
  vec2 uv=(ll-uZoneBB.xy)/uZoneBB.zw;
  vec4 a=textureLod(uZW0,uv,0.0), b=textureLod(uZW1,uv,0.0);
  float s=max(1e-4,a.x+a.y+a.z+a.w+b.x+b.y+b.z);
  zw[0]=a.x/s; zw[1]=a.y/s; zw[2]=a.z/s; zw[3]=a.w/s; zw[4]=b.x/s; zw[5]=b.y/s; zw[6]=b.z/s;
}
vec3 zRamp(int k,float e0,float dl){
  int n=int(texelFetch(uZLook,ivec2(${CLIM_STOPS},k),0).x+0.5);
  if(n==0) return uBeach==1 ? elevLand(e0) : elevLow(e0);
  vec4 a=texelFetch(uZLook,ivec2(0,k),0);
  if(e0<a.x) return a.yzw;
  float e=max(a.x,e0-dl);
  for(int i=0;i<${CLIM_STOPS - 1};i++){
    if(i+1>=n) break;
    vec4 b=texelFetch(uZLook,ivec2(i+1,k),0);
    if(e<b.x) return b.x>a.x ? mix(a.yzw,b.yzw,(e-a.x)/(b.x-a.x)) : b.yzw;
    a=b;
  }
  return a.yzw;
}
void zoneTree(float ecd,float dl0,out float ftc,out vec3 mead){
  float f=0.0; vec3 m=vec3(0.0);
  for(int k=0;k<${ZONE_N};k++){
    if(zw[k]<${W_EPS}) continue;
    vec4 p=texelFetch(uZLook,ivec2(${CLIM_STOPS},k),0), q=texelFetch(uZLook,ivec2(${CLIM_STOPS + 1},k),0);
    if(q.w<0.5) continue;
    float d=k==0?dl0:0.0, t=zw[k]*smoothstep(p.y+d,p.y+d+p.z,ecd);
    f+=t; m+=t*q.xyz;
  }
  ftc=f; mead=f>1e-5 ? m/f : vec3(0.0);
}
void zoneCol(float e,float dl0,out vec3 col,out float sn){
  vec3 c=vec3(0.0); float s=0.0, ws=0.0;
  for(int k=0;k<${ZONE_N};k++){
    if(zw[k]<${W_EPS}) continue;
    float d=k==0?dl0:0.0, snE=max(0.0,texelFetch(uZLook,ivec2(${CLIM_STOPS},k),0).w+d);
    c+=zw[k]*zRamp(k,e,d); s+=zw[k]*smoothstep(snE,snE+float(${FX.snowBand}),e); ws+=zw[k];
  }
  col=c/ws; sn=s/ws;
}`;
}
