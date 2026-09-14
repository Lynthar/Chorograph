/* 单飞行闸（shell/singleflight）：飞行中连叫只补发一次、拒绝与抛错都放闸、补发走注入的 refire、clearDirty 撤补发。
   这几条正是腿账 / 视域 / 侵蚀 / 精修四份闸各自注释里写的规则，收成一份之前一条都没有测试。 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { singleFlight } from "../src/shell/singleflight.ts";

/** 手动决议的单：调用方决定何时落地 */
function deferred() {
  let resolve!: (v?: unknown) => void, reject!: (e: unknown) => void;
  const p = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}
const flush = (): Promise<void> => new Promise(r => setImmediate(r));

describe("单飞行闸 singleFlight", () => {
  it("飞行中再叫几次都只记一个 dirty，落地后补发恰一次，且补发走 refire 不直接再进 run；参数原样进 run", async () => {
    const d = deferred(); const tags: string[] = []; let refires = 0;
    const g = singleFlight((tag: string) => { tags.push(tag); return d.p; }, () => { refires++; });
    g.fire("a"); g.fire("b"); g.fire("c"); g.fire("d");
    assert.deepEqual(tags, ["a"], "busy 期间不再进 run");
    d.resolve(); await flush();
    assert.equal(refires, 1, "落地后补发恰一次");
    assert.deepEqual(tags, ["a"], "补发是 refire 的事，闸不自己重跑 run");
    g.fire("e"); assert.deepEqual(tags, ["a", "e"], "落地即放闸：下一单立刻进 run");
  });
  it("没有 dirty 就不补发；clearDirty 撤掉飞行期记下的 dirty", async () => {
    let d = deferred(); let refires = 0;
    const g = singleFlight(() => d.p, () => { refires++; });
    g.fire(); d.resolve(); await flush();
    assert.equal(refires, 0, "无 dirty 不补发");
    d = deferred(); g.fire(); g.fire(); g.clearDirty(); d.resolve(); await flush();
    assert.equal(refires, 0, "clearDirty 之后落地不补发");
  });
  it("run 的 promise 拒绝：记录一次、放闸、dirty 照样补发", async () => {
    const err = mock.method(console, "error", () => {});
    try {
      const d = deferred(); let runs = 0, refires = 0;
      const g = singleFlight(() => { runs++; return d.p; }, () => { refires++; });
      g.fire(); g.fire();
      d.reject(new Error("dead")); await flush();
      assert.equal(err.mock.callCount(), 1, "拒绝要响");
      assert.equal(refires, 1, "拒绝后 dirty 照样补发");
      g.fire(); assert.equal(runs, 2, "拒绝后闸已放");
    } finally { err.mock.restore(); }
  });
  it("run 同步抛：同样记录并放闸（否则这条车道永哑）", async () => {
    const err = mock.method(console, "error", () => {});
    try {
      let runs = 0;
      const g = singleFlight(() => { runs++; if (runs === 1) throw new Error("boom"); return Promise.resolve(); }, () => {});
      g.fire(); await flush();
      assert.equal(err.mock.callCount(), 1);
      g.fire(); assert.equal(runs, 2, "同步抛之后闸已放");
    } finally { err.mock.restore(); }
  });
});
