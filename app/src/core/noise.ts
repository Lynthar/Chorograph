/* 程序化噪声（v0.12 起）：确定性数值噪声——同一 (x,y) 永远同值，存档只存种子。
   ⚠ 数值与旧实现逐位一致（黄金基准锁定）：任何常数改动都会改变既有存档的生成地形。 */

export const fract = (x: number): number => x - Math.floor(x);

export const hash2 = (x: number, y: number): number =>
  fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);

/* 四角哈希记忆化（2026-08-09 侵蚀提速批）：hash2 是 sin 基哈希、一次 vnoise 四次 sin，而侵蚀/
   地形生成都按行扫描——相邻采样点大量共享同一整数格（低频带一格横跨数百采样点）。
   直映射小表按 (xi,yi) **精确比中**（槽位撞了就重算，绝不误用），命中返回的是当初存下的
   同一批 double ⇒ 输出逐位不变（平价黄金与 erode 神谕两头锁）。表 96KB/模块实例（主线程与
   Worker 各一份，互不相扰）；实测侵蚀一趟 Math.sin 17.8M→约 1/10。 */
const VC = 2048;
const vcK = new Float64Array(VC * 2).fill(NaN);   // [xi,yi] 键（NaN 恒不等＝天然空槽）
const vcV = new Float64Array(VC * 4);             // [a,b,c,d] 四角哈希

/* 值噪声：单元格四角哈希 + smoothstep 双线性插值 */
export const vnoise = (x: number, y: number): number => {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const s = ((Math.imul(xi | 0, 0x9e3779b1) ^ Math.imul(yi | 0, 0x85ebca77)) >>> 0) & (VC - 1);
  let a: number, b: number, c: number, d: number;
  if (vcK[s * 2] === xi && vcK[s * 2 + 1] === yi) {
    a = vcV[s * 4]; b = vcV[s * 4 + 1]; c = vcV[s * 4 + 2]; d = vcV[s * 4 + 3];
  } else {
    a = hash2(xi, yi); b = hash2(xi + 1, yi); c = hash2(xi, yi + 1); d = hash2(xi + 1, yi + 1);
    vcK[s * 2] = xi; vcK[s * 2 + 1] = yi;
    vcV[s * 4] = a; vcV[s * 4 + 1] = b; vcV[s * 4 + 2] = c; vcV[s * 4 + 3] = d;
  }
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};

/* 分形布朗运动：4 个倍频叠加 */
export const fbm = (x: number, y: number): number => {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < 4; i++) { s += a * vnoise(x * f, y * f); f *= 2; a *= 0.5; }
  return s;
};
