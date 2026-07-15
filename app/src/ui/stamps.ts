/* 自定义印章：浏览器印章池（localStorage 跨图复用便捷层）+ 上传降采样。
   池是便捷层——便携仍靠每图内嵌 world.assets（见 render/decor.ts drawDecor、editops.addAsset）。
   纯逻辑 poolInsert 走 node:test；localStorage/DOM 包装薄壳走截图/CDP 目检。 */
import { signal } from "@preact/signals";
import type { Asset } from "../core/types.ts";

const KEY = "yutu2.stamps", CAP = 16;

/** 纯逻辑：把 asset 插入池数组（按 id 去重、最新在前、上限 cap） */
export function poolInsert(pool: Asset[], a: Asset, cap = CAP): Asset[] {
  return [a, ...pool.filter(x => x.id !== a.id)].slice(0, cap);
}
function readPool(): Asset[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v.filter((x: Asset) => x && x.id && x.src) : []; }
  catch { return []; }
}
function writePool(p: Asset[]): void { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* 配额/隐私模式：静默 */ } }

/** 印章池信号（DecorCtx 订阅） */
export const stampPoolSig = signal<Asset[]>(readPool());
export function poolAdd(a: Asset): void { const p = poolInsert(readPool(), a); writePool(p); stampPoolSig.value = p; }
export function poolRemove(id: string): void { const p = readPool().filter(x => x.id !== id); writePool(p); stampPoolSig.value = p; }
export function poolGet(id: string): Asset | undefined { return stampPoolSig.peek().find(x => x.id === id); }

let seq = 0;
/** 上传的 File → 降采样 ≤maxPx 长边、WebP-alpha（回退 PNG）→ Asset（生成稳定唯一 id） */
export async function fileToAsset(file: File, maxPx = 256): Promise<Asset> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error("读取失败")); r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("解码失败")); im.src = dataUrl;
  });
  const k = Math.min(1, maxPx / Math.max(img.width, img.height, 1));
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  cv.getContext("2d")!.drawImage(img, 0, 0, w, h);
  let src = cv.toDataURL("image/webp", 0.9);
  if (!src.startsWith("data:image/webp")) src = cv.toDataURL("image/png");   // 不支持 webp 编码时回退
  const id = "s" + Date.now().toString(36) + (seq++).toString(36);
  return { id, name: file.name.replace(/\.[^.]+$/, "").slice(0, 40) || "印章", src, w, h };
}
