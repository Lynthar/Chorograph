/* 只读分享的编解码：世界 JSON ⇄ 分享载荷（deflate-raw + base64url）。
   链接自带整张图，不需要任何服务端——同「单文件自包含 / 零外呼」两条红线。
   base64url 不含 `&` 与 `=`，可直接当 hash 参数值放进深链，不必再转义。 */

/** 解包上限：deflate 的解压比可达千倍，不限长就是「一条 URL 打爆内存」 */
export const SHARE_CAP = 8 * 1024 * 1024;

const B64URL = /^[A-Za-z0-9_-]*$/;

/** 字节 → base64url（无填充）。分块避免 fromCharCode 在大数组上爆栈 */
export function bytesToB64url(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * base64url → 字节。
 * @throws {Error} 载荷含 base64url 以外的字符（链接被聊天软件截断/改写）
 */
export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (!B64URL.test(s)) throw new Error("分享载荷不是合法的 base64url（链接可能被截断）");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function drain(rs: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = rs.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {   // 先取消再抛：否则源流留在挂起态，Node 下变成一条无人接的 rejection
      await reader.cancel().catch(() => {});
      throw new Error(`分享数据超出 ${Math.round(cap / 1048576)} MB 上限`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** 文本 → 分享载荷（UTF-8 → deflate-raw → base64url） */
export async function packShare(text: string): Promise<string> {
  const u8 = new TextEncoder().encode(text);
  const rs = new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return bytesToB64url(await drain(rs, SHARE_CAP));
}

/**
 * 分享载荷 → 文本。
 * @throws {Error} 载荷非法、不是 deflate-raw 数据、或解压后超过 cap
 */
export async function unpackShare(payload: string, cap: number = SHARE_CAP): Promise<string> {
  const rs = new Blob([b64urlToBytes(payload)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new TextDecoder().decode(await drain(rs, cap));
}

/** 分享链接里带上的视角/纪年（缺省不带＝开图用存档自身的快照） */
export interface ShareView {
  lon?: number | null;
  lat?: number | null;
  z?: number | null;
  year?: number | null;
  sel?: string | null;
}

/** 拼只读分享的 hash（`#ro=1&d=…`；数值取有限值，`sel` 编码后不含 `&`） */
export function shareHash(payload: string, v: ShareView = {}): string {
  const parts = ["ro=1", "d=" + payload];
  const num = (k: string, n: number | null | undefined): void => {
    if (typeof n === "number" && isFinite(n)) parts.push(`${k}=${+n.toFixed(6)}`);
  };
  num("lon", v.lon); num("lat", v.lat); num("z", v.z); num("year", v.year);
  if (v.sel) parts.push("sel=" + encodeURIComponent(v.sel));
  return "#" + parts.join("&");
}

/** 内嵌数据块的 id：导出的只读网页把整份世界 JSON 放这里，启动时优先读它（不受 URL 长度限制） */
export const SHARED_TAG_ID = "sharedWorld";
const OPEN = `<script type="application/json" id="${SHARED_TAG_ID}">`;
const CLOSE = "</" + "script>";

/* ⚠ 一律按**文末**定位，别拿这些字面量去 replace 整份产物：单文件产物把本模块的源码
   一起内联进了 <script>，于是 `</body>` 与上面那个开标签在 JS 字符串里各有一份。
   头一次写成 html.replace("</body>", …) 时，数据块被注进了脚本中间＝整个应用当场语法错。 */

/** 剥掉文末那一个旧数据块：认「紧挨 </body>、内容还能 JSON.parse」的那段，两道判据都得过 */
function stripTail(head: string): string {
  const at = head.lastIndexOf(OPEN);
  if (at < 0) return head;
  const close = head.indexOf(CLOSE, at + OPEN.length);
  if (close < 0 || head.slice(close + CLOSE.length).trim() !== "") return head;   // 其后还有正文＝不是数据块
  try { JSON.parse(head.slice(at + OPEN.length, close)); } catch (e) { return head; }   // 解不出＝命中的是内联 JS
  return head.slice(0, at);
}

/**
 * 把世界 JSON 嵌进一份应用 HTML，产出「双击即看」的只读网页。
 * @param html 应用自身的单文件产物
 * @param json 世界数据（`JSON.stringify` 的结果）
 * @returns 注入后的 HTML；已含数据块的先剥掉（转发别人的只读网页不叠加）
 * @throws {Error} html 里没有 `</body>`（不是应用产物，多半是 dev 页面或取错了文件）
 */
export function embedShareHtml(html: string, json: string): string {
  const end = html.lastIndexOf("</body>");
  if (end < 0) throw new Error("这份 HTML 不像应用产物（找不到 </body>）");
  // `<` 一律转义：JSON 里的 `</script>` 会当场截断脚本块，`<!--` 则把其后整段吞成注释
  const safe = json.replace(/</g, "\\u003c");
  return stripTail(html.slice(0, end)) + OPEN + safe + CLOSE + "\n" + html.slice(end);
}
