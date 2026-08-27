/* PNG 出图后处理（core/png 纯函数）：crc32 锚定公开校验值后，才允许拿它验 pHYs 分块——
   免「同一份实现自证等于没测」；pngSetDpi 锁 插入位置/替换语义/其余分块逐字节不动/坏输入必抛。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crc32, exportScaleFit, pngSetDpi } from "../src/core/png.ts";

const SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const cat = (...ps: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(ps.reduce((n, p) => n + p.length, 0));
  let w = 0;
  for (const p of ps) { out.set(p, w); w += p.length; }
  return out;
};
const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set([...type].map(c => c.charCodeAt(0)), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};
/** 独立小解析器：只按框架切分块（type + 区段），不复用被测代码 */
const chunks = (png: Uint8Array): { type: string; bytes: Uint8Array }[] => {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength), out = [];
  for (let off = 8; off < png.length;) {
    const end = off + 12 + dv.getUint32(off);
    out.push({ type: String.fromCharCode(...png.subarray(off + 4, off + 8)), bytes: png.subarray(off, end) });
    off = end;
  }
  return out;
};
const PNG = cat(SIG, chunk("IHDR", new Uint8Array(13)), chunk("IDAT", Uint8Array.from([1, 2, 3])), chunk("IEND", new Uint8Array(0)));

describe("crc32", () => {
  it("公开校验值锚定（标准 check value 与 IEND 常数）", () => {
    assert.strictEqual(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
    assert.strictEqual(crc32(new TextEncoder().encode("IEND")), 0xae426082);
    assert.strictEqual(crc32(new Uint8Array(0)), 0);
  });
});

describe("pngSetDpi", () => {
  it("pHYs 紧跟 IHDR，米制换算与自身 CRC 正确，其余分块逐字节不动", () => {
    const out = pngSetDpi(PNG, 96);
    assert.deepStrictEqual(out.subarray(0, 8), SIG);
    const cs = chunks(out);
    assert.deepStrictEqual(cs.map(c => c.type), ["IHDR", "pHYs", "IDAT", "IEND"]);
    const p = cs[1].bytes, pv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    assert.strictEqual(pv.getUint32(0), 9);
    assert.strictEqual(pv.getUint32(8), 3780);    // 96 dpi ÷ 0.0254 m = 3779.53 → 3780
    assert.strictEqual(pv.getUint32(12), 3780);
    assert.strictEqual(p[16], 1);                 // 单位＝米
    assert.strictEqual(pv.getUint32(17), crc32(p.subarray(4, 17)));
    const src = chunks(PNG);
    assert.deepStrictEqual(cs[0].bytes, src[0].bytes);
    assert.deepStrictEqual(cs[2].bytes, src[1].bytes);
    assert.deepStrictEqual(cs[3].bytes, src[2].bytes);
    assert.strictEqual(out.length, PNG.length + 21);
  });

  it("已有 pHYs 被替换成新值，只剩一份", () => {
    const twice = pngSetDpi(pngSetDpi(PNG, 96), 300);
    const ph = chunks(twice).filter(c => c.type === "pHYs");
    assert.strictEqual(ph.length, 1);
    assert.strictEqual(new DataView(ph[0].bytes.buffer, ph[0].bytes.byteOffset).getUint32(8), 11811);   // 300 dpi → 11811.02 → 11811
  });

  it("坏输入必抛：非 PNG / 分块截断 / 缺 IHDR / 非法 dpi", () => {
    assert.throws(() => pngSetDpi(new TextEncoder().encode("not a png at all"), 96));
    assert.throws(() => pngSetDpi(PNG.subarray(0, PNG.length - 4), 96));
    assert.throws(() => pngSetDpi(cat(SIG, chunk("IDAT", new Uint8Array(3)), chunk("IEND", new Uint8Array(0))), 96));
    for (const bad of [0, -300, NaN, Infinity]) assert.throws(() => pngSetDpi(PNG, bad));
  });
});

describe("exportScaleFit", () => {
  it("预算内原样放行；边长与面积各自钳；已超预算时保底 1", () => {
    assert.strictEqual(exportScaleFit(1920, 1080, 4, 16384, 64_000_000), 4);
    assert.strictEqual(exportScaleFit(5000, 3000, 4, 16000, 1e12), 3.2);          // 边长钳：16000/5000
    const a = exportScaleFit(3840, 2160, 4, 16384, 64_000_000);
    assert.ok(Math.abs(a - Math.sqrt(64_000_000 / (3840 * 2160))) < 1e-12, `面积钳实得 ${a}`);
    assert.strictEqual(exportScaleFit(20000, 12000, 4, 16384, 64_000_000), 1);    // 屏幕本身超预算＝不缩
  });
});
