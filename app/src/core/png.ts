/* PNG 出图后处理（纯函数）：pHYs 物理密度块＝打印 DPI 的载体，
   排版/打印软件按它换算物理尺寸；另含出图清晰度的尺寸钳制。 */

const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** 标准 CRC-32（PNG 分块校验用；测试锚定公开校验值 "123456789"→0xCBF43926） */
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 往 PNG 里写物理密度（pHYs，紧跟 IHDR；既有 pHYs 一律移除）。其余分块逐字节保留。
 * @throws 数据不是完好分块的 PNG（签名/框架/缺 IHDR）或 dpi 不是正有限数——
 *         调用方自行决定降级（如按无标记导出），这里不吞。
 */
export function pngSetDpi(png: Uint8Array, dpi: number): Uint8Array<ArrayBuffer> {
  if (!Number.isFinite(dpi) || dpi <= 0) throw new Error("DPI 必须是正数");
  if (png.length < 8 || PNG_SIG.some((v, i) => png[i] !== v)) throw new Error("不是 PNG 数据");
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const keep: [number, number][] = [];
  let ihdrEnd = 0, off = 8;
  while (off < png.length) {
    if (off + 12 > png.length) throw new Error("PNG 分块残缺");
    const end = off + 12 + dv.getUint32(off);
    if (end > png.length) throw new Error("PNG 分块残缺");
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    if (type === "IHDR") ihdrEnd = end;
    if (type !== "pHYs") keep.push([off, end]);
    off = end;
  }
  if (!ihdrEnd) throw new Error("PNG 缺 IHDR");
  const ppm = Math.round(dpi / 0.0254);   // 每米像素数（pHYs 单位是米，1 英寸=0.0254 米）
  const phys = new Uint8Array(21), pv = new DataView(phys.buffer);
  pv.setUint32(0, 9);
  phys.set([0x70, 0x48, 0x59, 0x73], 4);   // "pHYs"
  pv.setUint32(8, ppm); pv.setUint32(12, ppm); phys[16] = 1;
  pv.setUint32(17, crc32(phys.subarray(4, 17)));
  const out = new Uint8Array(8 + keep.reduce((n, [a, b]) => n + (b - a), 0) + phys.length);
  out.set(png.subarray(0, 8));
  let w = 8;
  for (const [a, b] of keep) {
    out.set(png.subarray(a, b), w); w += b - a;
    if (b === ihdrEnd) { out.set(phys, w); w += phys.length; }
  }
  return out;
}

/** 出图清晰度实得倍数：按最大边长与总像素预算钳 want，但不低于 1（屏幕原样是底线） */
export function exportScaleFit(w: number, h: number, want: number, maxDim: number, maxArea: number): number {
  const s = Math.min(want, maxDim / Math.max(w, h), Math.sqrt(maxArea / (w * h)));
  return Math.max(1, s);
}
