/* 深链解析（纯函数 parseHash）：数值守卫 + 枚举白名单 + 坏输入不致启动崩溃。
   这个文件此前零测试，而分享链接是外来输入——与存档同级不可信。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHash } from "../src/shell/deeplink.ts";
import { PRESETS } from "../src/core/constants.ts";

/* 原型键名同 behavior.test 的对抗集：查表的键名也是用户数据，深链是它的另一个入口 */
const PROTO_KEYS = ["__proto__", "toString", "constructor", "valueOf", "hasOwnProperty"];

describe("深链解析 parseHash", () => {
  it("空/裸键/坏编码：一律不崩，字段回落缺省", () => {
    for (const h of ["", "#", "#pts", "#map", "#=", "#&&&", "#%zz", "#map=%E4%B8", "#sel=%"]) {
      const d = parseHash(h);
      assert.strictEqual(typeof d, "object", h);
      assert.strictEqual(d.urlView, false, h);
    }
    assert.deepStrictEqual(parseHash("#pts").wantPts, [0], "裸 pts＝空串 split→[0]，不足 4 个数，消费端 length>=4 拦下");
    assert.deepStrictEqual(parseHash("#pts=a,b,c,d").wantPts, [NaN, NaN, NaN, NaN], "坏坐标留 NaN，消费端 every(isFinite) 拦下");
    assert.strictEqual(parseHash("#map=%").wantMap, "%", "坏 %编码原样返回，不抛");
  });

  it("数值守卫：坏值当没给；lon/lat 钳 1e6、z 须为正", () => {
    assert.strictEqual(parseHash("#year=abc").year, null);
    assert.strictEqual(parseHash("#year=3107").year, 3107);
    assert.strictEqual(parseHash("#year=3107").urlYear, true);
    assert.strictEqual(parseHash("#lon=1e9").lon, null, "天文值＝恶意/笔误链接");
    assert.strictEqual(parseHash("#lat=-1e9").lat, null);
    assert.strictEqual(parseHash("#lon=108&lat=38").urlView, true);
    assert.strictEqual(parseHash("#z=0").z, null, "0 不是合法缩放");
    assert.strictEqual(parseHash("#z=-0.1").z, null);
    assert.strictEqual(parseHash("#z=0.06").z, 0.06);
    assert.strictEqual(parseHash("#z=abc").urlView, false, "解析不出＝没给过，不该压制存档快照视角");
  });

  it("枚举白名单：非法值当没给过，不静默产出一个死工具/死预设", () => {
    assert.strictEqual(parseHash("#sub=add").wantSub, "add");
    assert.strictEqual(parseHash("#sub=node").wantSub, null, "拼错的子工具（正确是 add）不许静默生效");
    assert.strictEqual(parseHash("#mode=edit").wantAnalysis, "edit");
    assert.strictEqual(parseHash("#mode=乱写").wantAnalysis, null);
    assert.strictEqual(parseHash("#ovl=settings").wantOvl, "settings");
    assert.strictEqual(parseHash("#ovl=x").wantOvl, null);
    assert.strictEqual(parseHash("#drawer=layers").wantDrawer, "layers");
    assert.strictEqual(parseHash("#drawer=x").wantDrawer, null);
    assert.strictEqual(parseHash("#grain=month").wantGrain, "month");
    assert.strictEqual(parseHash("#grain=x").wantGrain, null);
    assert.strictEqual(parseHash("#force=cpu").force, "cpu");
    assert.strictEqual(parseHash("#force=x").force, undefined);
    assert.strictEqual(parseHash("#style=archipelago").style, "archipelago");
    assert.strictEqual(parseHash("#style=x").style, null);
    assert.strictEqual(parseHash("#arm=water").arm, "water");
    assert.strictEqual(parseHash("#arm=陆军").arm, null);
    const preset = Object.keys(PRESETS)[0];
    assert.strictEqual(parseHash("#preset=" + encodeURIComponent(preset)).wantPreset, preset);
    assert.strictEqual(parseHash("#preset=没这个").wantPreset, null);
  });

  it("原型键名：枚举参数一个都不许放行（否则查表取到继承成员＝图层全灭/切工具即崩）", () => {
    for (const k of PROTO_KEYS) {
      const d = parseHash(`#preset=${k}&sub=${k}&arm=${k}&style=${k}&mode=${k}&ovl=${k}&drawer=${k}&grain=${k}&force=${k}`);
      assert.deepStrictEqual(
        [d.wantPreset, d.wantSub, d.arm, d.style, d.wantAnalysis, d.wantOvl, d.wantDrawer, d.wantGrain, d.force],
        [null, null, null, null, null, null, null, null, undefined], k);
    }
  });

  it("自由文本参数照旧解码（图名/id 不设白名单——它们本就是任意串）", () => {
    assert.strictEqual(parseHash("#map=" + encodeURIComponent("井陉之战 · 战术")).wantMap, "井陉之战 · 战术");
    assert.strictEqual(parseHash("#sample=" + encodeURIComponent("长平之战-战术.json")).wantSample, "长平之战-战术.json");
    assert.deepStrictEqual(parseHash("#multi=" + encodeURIComponent("甲,乙")).wantMulti, ["甲", "乙"]);
    assert.deepStrictEqual(parseHash("#pts=1,2,3,4").wantPts, [1, 2, 3, 4]);
  });

  it("旗标与即时项：lib/hold/seed 的缺省逐位保留", () => {
    assert.strictEqual(parseHash("#lib=1").wantLib, true);
    assert.strictEqual(parseHash("").wantLib, false);
    assert.strictEqual(parseHash("#hold=1200").hold, 1200);
    assert.strictEqual(parseHash("#hold").hold, 5000, "裸 hold＝默认 5s");
    assert.strictEqual(parseHash("#seed=42").seed, 42);
    assert.strictEqual(parseHash("#seed=0").seed, 1, "0 被 `+v || 1` 吸成 1（既有行为，此处只作锁定）");
    assert.strictEqual(parseHash("").seed, null, "没给过＝不动 ctx.meta 的出厂种子");
  });

  it("前导 # 可有可无（供测试与非浏览器环境直接喂串）", () => {
    assert.deepStrictEqual(parseHash("#year=100"), parseHash("year=100"));
  });
});
