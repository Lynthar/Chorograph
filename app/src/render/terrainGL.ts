/* WebGL2 地形渲染器。
   职责边界：分类网格（游戏真源）由 core/grid 在 CPU 计算、作为 RG32F 纹理上传（R=示意高程 G=类型索引）；
   本模块只做像素观感——高程双线性 + 细节噪声 + 晕渲 + 色阶 + 生态色调 + 海岸线 + 等高线。
   等高线例外地画在**无噪声数据面**上（细节噪声纯装饰，读数不含）：细曲线+计曲线（每第 4 条），
   等距由 core/elev.contourStepFor 随缩放 ×2 阶梯自适应、过渡档按 uCFade 淡入。
   细节噪声用整数哈希 PCG2D（纯装饰、不入存档；sin-hash 在 fp32 下大参数失谐、不可移植）。 */
import { ELEV, terrainProps, compositeIndex, allComposites, COMPOSITE_COUNT } from "../core/constants.ts";
import type { Grid } from "../core/grid.ts";
import type { BBox } from "../core/types.ts";

const VS = `#version 300 es
void main(){ vec2 p=vec2(float(gl_VertexID<<1&2), float(gl_VertexID&2)); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;

const FS = `#version 300 es
precision highp float; precision highp int;
const float SEA_E=float(${ELEV.water});                        // 深海高程（构建期注入，与 core 常量同源）
const float SEA_T=float(${compositeIndex("water")});           // water 复合索引（G 通道）
uniform sampler2D uGrid;          // RG32F: R=格高程 G=复合索引(lf*5+eco)
uniform vec4 uGridBB;             // lonMin,latMin,step,wrap中心经度
uniform ivec2 uGridDim;           // cols,rows
uniform vec2 uGridSpan;           // 网格真实跨度(lonMax-lonMin,latMax-latMin)：出界判定用，对齐 CPU/旧版 bbox
uniform vec4 uViewBB;             // lonMin,latMin,lonMax,latMax
uniform vec2 uRes;                // 画布像素
uniform float uPXPD;              // 横向像素/度（经度有 cos(lat0) 校正，与纵向不同）
uniform float uPXPDY;             // 纵向像素/度（对齐旧 drawTile 经 project 的各向异性贴图）
uniform float uCMinor;            // 细曲线等距（抽象单位；contourStepFor 缩放自适应 ×2 阶梯）
uniform float uCFade;             // 下一细分档淡入 0..1（×2 嵌套：新线在旧线正中浮现）
uniform vec3 uLight;
uniform int uMode;                // 0=着色 1=诊断平色
uniform int uContour;
uniform int uWrap;                // 1=球面经度环绕（把片元经度折回世界本初域），0=平面
uniform vec3 uTColor[${COMPOSITE_COUNT}];   // 各复合诊断平色（G=lf*5+eco 索引）
uniform vec3 uTint[${COMPOSITE_COUNT}];     // 各复合生态色调（无=vec3(-1)）
out vec4 fragColor;

/* 细节噪声：整数哈希(PCG2D)值噪声 */
uvec2 pcg2d(uvec2 v){ v=v*1664525u+1013904223u; v.x+=v.y*1664525u; v.y+=v.x*1664525u;
  v^=v>>16u; v.x+=v.y*1664525u; v.y+=v.x*1664525u; v^=v>>16u; return v; }
float hashI(ivec2 p){ return float(pcg2d(uvec2(p+40000)).x)*(1.0/4294967296.0); }
float vnoise2(vec2 x){ ivec2 i=ivec2(floor(x)); vec2 f=fract(x); vec2 u=f*f*(3.0-2.0*f);
  float a=hashI(i),b=hashI(i+ivec2(1,0)),c=hashI(i+ivec2(0,1)),d=hashI(i+ivec2(1,1));
  return a+(b-a)*u.x+(c-a)*u.y+(a-b-c+d)*u.x*u.y; }
float fbm4(vec2 x){ float s=0.0,a=0.5; for(int i=0;i<4;i++){ s+=a*vnoise2(x); x*=2.0; a*=0.5; } return s; }

vec2 cellAt(vec2 ll){ // (双线性高程, 最近格类型索引)——语义对齐旧版 gridElevBilinear/nearestType
  // 网格 bbox 之外=深海（对齐 CPU 兜底先铺深水的行为；用真实跨度而非 cols×step——后者 ceil 多出 <1 格边缘条带）
  vec2 rel=ll-uGridBB.xy;
  if(rel.x<0.0||rel.y<0.0||rel.x>uGridSpan.x||rel.y>uGridSpan.y) return vec2(SEA_E, SEA_T);
  vec2 f=(ll-uGridBB.xy)/uGridBB.z-0.5;
  ivec2 c0=clamp(ivec2(floor(f)), ivec2(0), uGridDim-1);
  ivec2 c1=min(c0+1, uGridDim-1);
  vec2 t=clamp(f-vec2(c0), 0.0, 1.0);
  float e00=texelFetch(uGrid,ivec2(c0.x,c0.y),0).r, e10=texelFetch(uGrid,ivec2(c1.x,c0.y),0).r;
  float e01=texelFetch(uGrid,ivec2(c0.x,c1.y),0).r, e11=texelFetch(uGrid,ivec2(c1.x,c1.y),0).r;
  float top=e00+(e10-e00)*t.x, bot=e01+(e11-e01)*t.x;
  ivec2 n=clamp(ivec2(floor((ll-uGridBB.xy)/uGridBB.z)), ivec2(0), uGridDim-1);
  return vec2(top+(bot-top)*t.y, texelFetch(uGrid,n,0).g);
}
float elevAt(vec2 ll){
  float e=cellAt(ll).x;
  float rough=e>0.4?0.24:(e>0.2?0.08:0.025);
  return e+(fbm4(ll*1.1)-0.5)*rough*2.0;
}
float elevSmooth(vec2 ll){ // 制图面：±半格 4 抽头帐篷平滑（与 core/elev.elevSmooth 同式——读数=线）
  float h=0.5*uGridBB.z;
  return 0.25*(cellAt(ll+vec2(-h,-h)).x+cellAt(ll+vec2(h,-h)).x+cellAt(ll+vec2(-h,h)).x+cellAt(ll+vec2(h,h)).x);
}
/* 等高线助手：d=到最近整倍等值面的像素距（数值 +1e-6 防零梯度平台整面刷线）。
   cwMinor/cwIndex 带宽不同（计曲线加宽）；oddK=倍数奇偶（×2 阶梯过渡期只淡入奇数倍新线） */
float cwMinor(float eh,float itv,float aa){ float u=eh/itv; float d=(abs(u-round(u))*itv+1e-6)/aa; return 1.0-smoothstep(0.8,1.5,d); }
float cwIndex(float eh,float itv,float aa){ float u=eh/itv; float d=(abs(u-round(u))*itv+1e-6)/aa; return 1.0-smoothstep(1.3,2.4,d); }
float oddK(float eh,float itv){ return mod(round(eh/itv),2.0); }
vec3 elevRamp(float e){
  if(e<-0.02){ float t=clamp((e+0.35)/0.33,0.0,1.0); return vec3(40.0+t*60.0,90.0+t*70.0,132.0+t*66.0)/255.0; }
  if(e<0.09) return vec3(224.0,216.0,172.0)/255.0;
  if(e<0.30){ float t=(e-0.09)/0.21; return vec3(132.0+t*38.0,174.0-t*2.0,98.0+t*12.0)/255.0; }
  if(e<0.55){ float t=(e-0.30)/0.25; return vec3(170.0+t*8.0,166.0-t*12.0,110.0-t*4.0)/255.0; }
  if(e<0.82){ float t=(e-0.55)/0.27; return vec3(178.0-t*28.0,152.0-t*24.0,118.0-t*22.0)/255.0; }
  float t=min(1.0,(e-0.82)/0.18); return vec3(140.0+t*100.0,132.0+t*104.0,124.0+t*118.0)/255.0;
}
void main(){
  float x=gl_FragCoord.x-0.5, yTop=uRes.y-gl_FragCoord.y-0.5;   // 与 CPU 版角点采样对齐
  vec2 ll=vec2(uViewBB.x+x/uPXPD, uViewBB.w-yTop/uPXPDY);
  // 球面环绕：经度折回以网格中心为轴的 ±180° 域——单次绘制即无缝跨越 ±180° 经线
  if(uWrap==1) ll.x-=360.0*floor((ll.x-uGridBB.w+180.0)/360.0);
  vec2 cd=cellAt(ll);   // (双线性数据面高程, 最近格类型索引)：等高线/类型共用，晕渲另走带噪声的 elevAt
  if(uMode==1){ int ti=int(cd.y+0.5); fragColor=vec4(uTColor[ti],1.0); return; }
  float px=1.0/uPXPD, py=1.0/uPXPDY;
  float e =elevAt(ll);
  float eL=elevAt(ll+vec2(-px,0.0)), eR=elevAt(ll+vec2(px,0.0));
  float eU=elevAt(ll+vec2(0.0, py)), eD=elevAt(ll+vec2(0.0,-py));
  float nrm=4.5*(uPXPD/14.0);
  vec3 nv=vec3((eL-eR)*nrm,(eU-eD)*nrm,1.0);
  float sh=0.6+0.75*max(0.0, dot(normalize(nv), uLight));
  vec3 col=elevRamp(e);
  if(e>=-0.02){
    int ti=int(cd.y+0.5);
    vec3 tint=uTint[ti];
    if(tint.x>=0.0) col=col*0.55+(tint/255.0)*0.45;
    col*=sh;
  }
  float aa=fwidth(e)+1e-6;
  float es=elevSmooth(ll);      // 制图面（帐篷平滑数据面，与光标读数同源）；导数须在一致控制流取（分支内 fwidth 未定义，软渲返 0）
  float ad=fwidth(es)+1e-7;
  float coast=1.0-smoothstep(0.0, aa*1.4, abs(e+0.02));
  col=mix(col, vec3(38.0,66.0,86.0)/255.0, coast*0.55);
  vec2 rg=ll-uGridBB.xy;   // 网格内缩一格的图幅裁边：世界 bbox 外=深海，制图面在边缘塌向海——贴边假线截掉（neatline 惯例）
  if(uContour==1 && es>=-0.02 && rg.x>uGridBB.z && rg.y>uGridBB.z && rg.x<uGridSpan.x-uGridBB.z && rg.y<uGridSpan.y-uGridBB.z){
    // 等高线画在制图面 es（晕渲是画，等高线是尺）。细曲线=当前档整倍+半档奇数倍×uCFade 淡入；计曲线=每第 4 条。
    // 挤线抑制（真图规范）：线距不足数像素的陡坎处细曲线隐去；计曲线按自身 4× 线距评估而幸存。
    float eh=es+0.02;
    float mn=max(cwMinor(eh,uCMinor,ad), cwMinor(eh,uCMinor*0.5,ad)*oddK(eh,uCMinor*0.5)*uCFade);
    float ix=max(cwIndex(eh,uCMinor*4.0,ad), cwIndex(eh,uCMinor*2.0,ad)*oddK(eh,uCMinor*2.0)*uCFade);
    float sup=smoothstep(2.5,6.0,uCMinor/ad), supIx=smoothstep(2.5,6.0,uCMinor*4.0/ad);
    col=mix(col, vec3(90.0,70.0,40.0)/255.0, max(mn*0.50*sup, ix*0.70*supIx));
  }
  fragColor=vec4(col,1.0);
}`;

import type { TerrainRenderer, TerrainRenderOpts } from "./renderer.ts";

const hexV = (hex: string): [number, number, number] =>
  [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];

/** 编译+链接着色器程序；任一步失败返回 null（不 throw——探针与实建共用）。 */
function compileProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const mk = (type: number, src: string): WebGLShader | null => {
    const o = gl.createShader(type);
    if (!o) return null;
    gl.shaderSource(o, src); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) { console.warn("着色器编译失败：", gl.getShaderInfoLog(o)); gl.deleteShader(o); return null; }
    return o;
  };
  const vs = mk(gl.VERTEX_SHADER, VS), fs = mk(gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) return null;
  const pr = gl.createProgram();
  if (!pr) return null;
  gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { console.warn("着色器链接失败：", gl.getProgramInfoLog(pr)); gl.deleteProgram(pr); return null; }
  return pr;
}

/** 探针：一次性 canvas 上把同一份着色器编译+链接一遍，成功才让真 canvas 走 GL。
    因 canvas 一旦 getContext("webgl2") 即永久锁进 GL 模式——若之后编译失败退 CPU，
    terrainCPU 的 getContext("2d") 会返 null 令首帧崩（审计：救命兜底自毁）。探针在真
    canvas 之前预判，用后即以 WEBGL_lose_context 释放。 */
function probeGL(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2", { antialias: false });
    if (!gl) return false;
    const pr = compileProgram(gl);
    if (pr) gl.deleteProgram(pr);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return !!pr;
  } catch { return false; }
}

/** 创建渲染器；环境无 WebGL2 或着色器建不出时返回 null（由 renderer.ts 工厂决定走 CPU 兜底） */
export function createTerrainGL(canvas: HTMLCanvasElement): TerrainRenderer | null {
  if (!probeGL()) return null;   // 探针先行：不过则不碰真 canvas，工厂安全退 CPU
  const glMaybe = canvas.getContext("webgl2", { antialias: false });
  if (!glMaybe) return null;
  const gl = glMaybe;   // 固化非空绑定，供下方闭包捕获（避免联合类型收窄不传入闭包）

  let pr: WebGLProgram | null = null;
  let tex: WebGLTexture | null = null;
  let g: Grid | null = null;
  let lastElev: Float32Array | undefined;   // 存最近高程场：上下文丢失恢复时重传
  const U = (n: string) => gl.getUniformLocation(pr!, n);

  /* 建程序 + 设常量 uniform（创建时 + webglcontextrestored 后重跑）。 */
  function initProgram(): boolean {
    pr = compileProgram(gl);
    if (!pr) return false;
    gl.useProgram(pr);
    gl.uniform1i(U("uGrid"), 0);
    const light = [-0.6, -0.6, 0.9], ll = Math.hypot(...light);
    gl.uniform3f(U("uLight"), light[0] / ll, light[1] / ll, light[2] / ll);
    const comps = allComposites();   // 25 个复合，顺序与 compositeIndex 对齐（旧 8 类落在各自复合上、色/tint 逐位复现）
    gl.uniform3fv(U("uTColor[0]"), comps.flatMap(cc => hexV(terrainProps(cc).color)));
    gl.uniform3fv(U("uTint[0]"), comps.flatMap(cc => { const t = terrainProps(cc).tint; return t ? [t[0], t[1], t[2]] : [-1, -1, -1]; }));
    return true;
  }
  function doUpload(grid: Grid, elev?: Float32Array) {
    if (!pr) return;
    if (tex) gl.deleteTexture(tex);
    const data = new Float32Array(grid.cols * grid.rows * 2);
    for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
      const t = grid.cells[r][c], i = (r * grid.cols + c) * 2, k = r * grid.cols + c;
      data[i] = elev ? elev[k] : terrainProps(t).elev; data[i + 1] = compositeIndex(t);   // R=高程场(缺省示意常数)；G=复合索引 lf*5+eco
    }
    tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, grid.cols, grid.rows, 0, gl.RG, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform4f(U("uGridBB"), grid.bb.lonMin, grid.bb.latMin, grid.step, (grid.bb.lonMin + grid.bb.lonMax) / 2);
    gl.uniform2i(U("uGridDim"), grid.cols, grid.rows);
    gl.uniform2f(U("uGridSpan"), grid.bb.lonMax - grid.bb.lonMin, grid.bb.latMax - grid.bb.latMin);
  }

  if (!initProgram()) return null;   // 探针过后此处基本必过；稳妥兜底

  /* 上下文丢失/恢复（GPU 进程崩溃、驱动重置、后台标签回收）：
     preventDefault 才有 restored；恢复后 program/纹理全失效，重建并重传网格——
     下一帧 rAF 自动出图，外壳零改动。缺此则地形永久空白（审计）。 */
  const onLost = (e: Event) => { e.preventDefault(); };
  const onRestored = () => { tex = null; if (initProgram() && g) doUpload(g, lastElev); };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    canvas, kind: "webgl2",
    uploadGrid(grid: Grid, elev?: Float32Array) { g = grid; lastElev = elev; doUpload(grid, elev); },
    render(viewBB: BBox, opts: TerrainRenderOpts = {}) {
      if (!g || !pr) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform4f(U("uViewBB"), viewBB.lonMin, viewBB.latMin, viewBB.lonMax, viewBB.latMax);
      gl.uniform2f(U("uRes"), canvas.width, canvas.height);
      gl.uniform1f(U("uPXPD"), canvas.width / (viewBB.lonMax - viewBB.lonMin));
      gl.uniform1f(U("uPXPDY"), canvas.height / (viewBB.latMax - viewBB.latMin));
      gl.uniform1i(U("uMode"), opts.diag ? 1 : 0);
      gl.uniform1i(U("uContour"), opts.contour ? 1 : 0);
      gl.uniform1f(U("uCMinor"), opts.cMinor || 0.12);
      gl.uniform1f(U("uCFade"), opts.cFade || 0);
      gl.uniform1i(U("uWrap"), opts.wrap ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    rendererName() {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return (ext && (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string)) || (gl.getParameter(gl.RENDERER) as string) || "WebGL2";
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (tex) gl.deleteTexture(tex);
      if (pr) gl.deleteProgram(pr);
    }
  };
}
