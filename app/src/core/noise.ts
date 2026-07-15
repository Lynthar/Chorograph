/* 程序化噪声（v0.12 起）：确定性数值噪声——同一 (x,y) 永远同值，存档只存种子。
   ⚠ 数值与旧实现逐位一致（黄金基准锁定）：任何常数改动都会改变既有存档的生成地形。 */

export const fract = (x: number): number => x - Math.floor(x);

export const hash2 = (x: number, y: number): number =>
  fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);

/* 值噪声：单元格四角哈希 + smoothstep 双线性插值 */
export const vnoise = (x: number, y: number): number => {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};

/* 分形布朗运动：4 个倍频叠加 */
export const fbm = (x: number, y: number): number => {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < 4; i++) { s += a * vnoise(x * f, y * f); f *= 2; a *= 0.5; }
  return s;
};
