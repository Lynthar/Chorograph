/* 只读分享的编解码（core/share 纯函数）：链接自带整张图，所以载荷是**别人给的数据**——
   与存档、深链同级不可信。这里锁的是往返恒等、URL 安全、解压上限与注入转义四条。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SHARE_CAP, b64urlToBytes, bytesToB64url, embedShareHtml, packShare, shareHash, unpackShare } from "../src/core/share.ts";
import { parseHash } from "../src/shell/deeplink.ts";

const WORLD = JSON.stringify({
  meta: { 名称: "井陉之战 · 战术", mapKind: "tactical", bbox: { lonMin: 113, lonMax: 114, latMin: 37, latMax: 38 } },
  factions: [{ id: "han", 名称: "汉" }], nodes: [], edges: [], decor: [], terrainOverrides: []
});

describe("分享载荷编解码", () => {
  it("往返恒等：中文 / 空串 / 大体量都逐字取回", async () => {
    for (const src of ["", "a", WORLD, "玄之又玄".repeat(5000), JSON.stringify({ n: Array.from({ length: 5000 }, (_, i) => i) })]) {
      assert.strictEqual(await unpackShare(await packShare(src)), src, src.slice(0, 12));
    }
  });

  it("载荷可直接当 hash 参数值：不含 & = + / 与百分号", async () => {
    const p = await packShare(WORLD);
    assert.match(p, /^[A-Za-z0-9_-]+$/, "base64url 才能免转义地进 URL");
    /* 这条是跨模块契约：shareHash 拼出来的串必须能被 parseHash 原样取回——
       载荷里若混进 & 或 =，深链会从中间截断，链接看着完好却载不出图。 */
    const dl = parseHash(shareHash(p, { lon: 113.5, lat: 37.8, z: 0.002, year: 3107, sel: "地点 甲" }));
    assert.strictEqual(dl.wantData, p);
    assert.strictEqual(dl.wantRo, true);
    assert.strictEqual(dl.lon, 113.5);
    assert.strictEqual(dl.lat, 37.8);
    assert.strictEqual(dl.z, 0.002);
    assert.strictEqual(dl.year, 3107);
    assert.strictEqual(dl.wantSel, "地点 甲");
    assert.strictEqual(await unpackShare(dl.wantData!), WORLD);
  });

  it("shareHash：坏数值当没给过，缺省只有 ro 与 d", async () => {
    const p = await packShare("{}");
    assert.strictEqual(shareHash(p), "#ro=1&d=" + p);
    assert.strictEqual(shareHash(p, { lon: NaN, lat: Infinity, z: null, year: undefined }), "#ro=1&d=" + p,
      "NaN/Infinity 进了 URL 会写坏相机（首帧渲染前不经 clampView）");
  });

  it("坏载荷要响：非 base64url 字符、截断的链接一律抛，不静默产出空世界", async () => {
    for (const bad of ["!!!", "abc def", "a/b+c", "载荷"]) {
      await assert.rejects(() => unpackShare(bad), /base64url/, bad);
    }
    await assert.rejects(() => unpackShare("AAAA"), "合法 base64url 但不是 deflate 数据");
  });

  it("解压上限：高压缩比的载荷不许把内存撑爆", async () => {
    const bomb = await packShare("a".repeat(2_000_000));
    assert.ok(bomb.length < 4000, "2MB 同字节压完不足 4KB——这正是炸弹的形状");
    await assert.rejects(() => unpackShare(bomb, 1000), /上限/);
    assert.strictEqual((await unpackShare(bomb, SHARE_CAP)).length, 2_000_000, "限内照常解出");
  });

  it("字节 ⇄ base64url 无填充，且长度各余数都能回",  () => {
    for (let n = 0; n < 8; n++) {
      const u8 = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + 251) % 256));
      const s = bytesToB64url(u8);
      assert.doesNotMatch(s, /=/, "填充号会与 hash 的 k=v 分隔号打架");
      assert.deepStrictEqual([...b64urlToBytes(s)], [...u8], "n=" + n);
    }
  });
});

describe("只读网页的数据注入", () => {
  const HTML = "<!DOCTYPE html><html><head><title>舆图</title></head><body><div id=app></div>\n</body></html>";

  it("`<` 一律转义：JSON 里的 </script> 不许截断脚本块", () => {
    const out = embedShareHtml(HTML, JSON.stringify({ 说明: "</script><img src=x onerror=alert(1)>", 注: "<!--" }));
    const body = out.slice(out.indexOf('id="sharedWorld"'));
    assert.doesNotMatch(body.slice(0, body.indexOf("</script>")), /</, "数据块里不该再有裸 <");
    assert.ok(out.includes("\\u003c/script>"), "转义后仍是合法 JSON 转义序列");
    assert.strictEqual(JSON.parse(extract(out)).说明, "</script><img src=x onerror=alert(1)>",
      "解析回来仍是原文——转义只作用在 HTML 这一层");
  });

  it("转发不叠加：已含数据块的网页再导出，只留新的那一份", () => {
    const once = embedShareHtml(HTML, JSON.stringify({ v: 1 }));
    const twice = embedShareHtml(once, JSON.stringify({ v: 2 }));
    assert.strictEqual(twice.match(/id="sharedWorld"/g)!.length, 1);
    assert.strictEqual(JSON.parse(extract(twice)).v, 2);
  });

  /* 单文件产物把 share.ts 的源码一起内联进 <script>，于是 `</body>` 与数据块的开标签在 JS
     字符串里各有一份。头一版按 replace("</body>") 注入，数据块落进了脚本中间＝应用当场语法错
     （无头实机撞出来的）。故这里拿「内联 JS 里含这些字面量」的产物形状锁住。 */
  const BUNDLED = `<!DOCTYPE html><html><head></head><body><div id=app></div>`
    + `<script>const OPEN='<script type="application/json" id="sharedWorld">';`
    + `const s='</body>';if(!h.includes('</body>'))throw 0;<\/script>`
    + `\n</body></html>`;

  it("按文末定位：内联 JS 里的同名字面量不许被当成注入点", () => {
    const out = embedShareHtml(BUNDLED, JSON.stringify({ v: 1 }));
    assert.ok(out.indexOf('id="sharedWorld">{"v":1}') > out.indexOf("<\/script>"), "数据块必须在脚本之后");
    assert.match(out.slice(out.lastIndexOf('id="sharedWorld">')), /^id="sharedWorld">\{"v":1\}<\/script>\n<\/body><\/html>$/);
    assert.ok(out.includes(`const s='</body>';`), "内联 JS 一字未动");
  });

  it("剥旧块要认内容：解不出 JSON 的（＝命中内联 JS）一概不剪", () => {
    const once = embedShareHtml(BUNDLED, JSON.stringify({ v: 1 }));
    const twice = embedShareHtml(once, JSON.stringify({ v: 2 }));
    assert.strictEqual(twice.match(/id="sharedWorld">\{/g)!.length, 1, "转发不叠加");
    assert.strictEqual(JSON.parse(extract(twice)).v, 2);
    assert.ok(twice.includes(`const s='</body>';`), "内联 JS 仍一字未动");
  });

  it("不是应用产物就要响（dev 页面/取错文件）", () => {
    assert.throws(() => embedShareHtml("<html><head></head>", "{}"), /body/);
  });
});

/** 取回数据块原文。取**最后**一个：产物内联的 JS 里也有同名字面量，
    浏览器那边不会认错（那段在 <script> 里、不成元素），字符串层得自己分清 */
function extract(html: string): string {
  const at = html.lastIndexOf('id="sharedWorld">');
  assert.ok(at >= 0, "找不到数据块");
  const from = at + 'id="sharedWorld">'.length;
  return html.slice(from, html.indexOf("</" + "script>", from));
}
