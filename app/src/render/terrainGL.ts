/* WebGL2 地形渲染器。
   职责边界：分类网格（游戏真源）由 core/grid 在 CPU 计算、作为 RG32F 纹理上传（R=示意高程 G=类型索引）；
   本模块只做像素观感——高程双线性 + 细节噪声 + 晕渲 + 色阶 + 生态色调 + 海岸线 + 等高线。
   等高线例外地画在**无噪声数据面**上（细节噪声纯装饰，读数不含）：细曲线+计曲线（每第 4 条），
   等距由 core/elev.contourStepFor 随缩放 ×2 阶梯自适应、过渡档按 uCFade 淡入。
   细节噪声用整数哈希 PCG2D（纯装饰、不入存档；sin-hash 在 fp32 下大参数失谐、不可移植）。

   缩放自适应观感（2026-08 美化批，material.ts 是数值真源，CPU 兜底同构）：
   - 类型/色调查找过**域扭曲**（波长≈1.3 格、幅度<半格，格空间标定=缩放稳定）+ 四角双线性软过渡
     ——生态色斑从轴对齐方格变有机斑块；地形分类（游戏真源）与等高线不经扭曲。
   - 高程细节分两层：**微八度**（世界锚定 ×2 阶梯接续宏观 fbm4 频谱，逐档按屏幕波长门控淡入，
     整幅视角下全零=旧缩放档观感保持）；**材质纹理**（林冠/沙丘/棱脊/沼泽，屏幕波长锚定+双档
     crossfade，只进光照法线，不进色阶/海岸/等高线判据——质感是示意不是地物）。
   - 坡度岩化 + 帐篷差谷影（AO）+ 水域近岸带与静态波纹（无动画，尊重空闲降频）。
   ⚠ 噪声坐标一律用图幅局部坐标（ll-网格原点），深放大高频档才不在 fp32 下失谐；
   ⚠ fwidth 只喂 e/es 两个一致控制流值，材质分支里不得调用。 */
import { ELEV, terrainProps, compositeIndex, allComposites, COMPOSITE_COUNT } from "../core/constants.ts";
import { materialTable, MICRO_F0, MICRO_OCTAVES, FX } from "./material.ts";
import type { Grid } from "../core/grid.ts";
import type { ElevField } from "../core/elev.ts";
import type { BBox } from "../core/types.ts";

const VS = `#version 300 es
void main(){ vec2 p=vec2(float(gl_VertexID<<1&2), float(gl_VertexID&2)); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;

const FS = `#version 300 es
precision highp float; precision highp int;
const float SEA_E=float(${ELEV.water});                        // 深海高程（构建期注入，与 core 常量同源）
const float SEA_T=float(${compositeIndex("water")});           // water 复合索引（G 通道）
uniform sampler2D uGrid;          // RG32F: R=弃用(恒 0) G=复合索引(lf*5+eco)——类型仍粗格最近取
uniform sampler2D uField;         // RG32F: R=高程场 G=定向遮蔽 0..1（粗格=coarseField 全零；细分=erode 产出）
uniform vec4 uGridBB;             // lonMin,latMin,step,wrap中心经度
uniform ivec2 uGridDim;           // cols,rows（类型粗格）
uniform ivec2 uFDim;              // 高程场维度（侵蚀细分后 ≠ uGridDim）
uniform float uFStep;             // 度/场格
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
uniform int uPaper;               // 1=图幅外铺宣纸色（战术图；色=出图垫纸色 #d9d2c0 同源）
uniform float uSnowE;             // 雪线抽象高程（material.snowEOf 按米折算；不落雪=1e9）
uniform vec3 uTColor[${COMPOSITE_COUNT}];   // 各复合诊断平色（G=lf*5+eco 索引）
uniform vec3 uTint[${COMPOSITE_COUNT}];     // 各复合生态色调（无=vec3(-1)）
uniform vec4 uMatA[${COMPOSITE_COUNT}];     // 材质纹理权重(canopy,dune,ridge,marsh)——render/material.ts 真源
uniform vec4 uMatB[${COMPOSITE_COUNT}];     // (微起伏rough, 反照率抖动albVar, 岩化rock, 0)
out vec4 fragColor;

/* 细节噪声：整数哈希(PCG2D)值噪声 */
uvec2 pcg2d(uvec2 v){ v=v*1664525u+1013904223u; v.x+=v.y*1664525u; v.y+=v.x*1664525u;
  v^=v>>16u; v.x+=v.y*1664525u; v.y+=v.x*1664525u; v^=v>>16u; return v; }
float hashI(ivec2 p){ return float(pcg2d(uvec2(p+40000)).x)*(1.0/4294967296.0); }
float vnoise2(vec2 x){ ivec2 i=ivec2(floor(x)); vec2 f=fract(x); vec2 u=f*f*(3.0-2.0*f);
  float a=hashI(i),b=hashI(i+ivec2(1,0)),c=hashI(i+ivec2(0,1)),d=hashI(i+ivec2(1,1));
  return a+(b-a)*u.x+(c-a)*u.y+(a-b-c+d)*u.x*u.y; }
float fbm4(vec2 x){ float s=0.0,a=0.5; for(int i=0;i<4;i++){ s+=a*vnoise2(x); x*=2.0; a*=0.5; } return s; }
/* 梯度噪声（Perlin 型，±0.7）：棱脊/沙丘的 ridged 变换必须用它——值噪声的极值沿格线连通，
   ridged 后是迷宫状蠕虫纹；梯度噪声的脊线才有自然山脊形态 */
vec2 grad2(ivec2 p){ float a=hashI(p)*6.2831853; return vec2(cos(a),sin(a)); }
float gnoise2(vec2 x){ ivec2 i=ivec2(floor(x)); vec2 f=fract(x); vec2 u=f*f*(3.0-2.0*f);
  float a=dot(grad2(i),f), b=dot(grad2(i+ivec2(1,0)),f-vec2(1.0,0.0)),
        c=dot(grad2(i+ivec2(0,1)),f-vec2(0.0,1.0)), d=dot(grad2(i+ivec2(1,1)),f-vec2(1.0,1.0));
  return a+(b-a)*u.x+(c-a)*u.y+(a-b-c+d)*u.x*u.y; }
float rg(float n){ return 1.0-min(1.0,abs(n)*1.9); }   // 梯度噪声 → 脊形（峰=1 谷=0）

const float MF0=float(${MICRO_F0});   // 微八度基频（接续 fbm4 频谱下一档；material.ts 单一真源）
/* 八度门控（同 material.octaveGate）：屏幕波长 3px 起淡入、8px 全强——整幅视角下恒 0=旧观感 */
float gate(float f){ return smoothstep(3.0,8.0,uPXPD/f); }
float ridged(float n){ return 1.0-abs(2.0*n-1.0); }
/* 屏幕波长 tpx 锚定的两档世界频率 + crossfade（×2 阶梯嵌套，缩放连续无跳档） */
vec3 lodF(float tpx){ float fi=max(MF0, uPXPD/tpx); float f=MF0*exp2(floor(log2(fi/MF0)));
  return vec3(f, f*2.0, fract(log2(fi/MF0))); }
/* 域扭曲（类型/色调查找用）：双频、幅度 <半格、格空间标定=缩放稳定 */
vec2 warpOf(vec2 rel){
  float wf=float(${FX.warpF})/uGridBB.z;
  vec2 w1=vec2(vnoise2(rel*wf+vec2(13.7,91.2)), vnoise2(rel*wf+vec2(57.1,33.9)))-0.5;
  vec2 w2=vec2(vnoise2(rel*wf*3.1+vec2(7.3,44.9)), vnoise2(rel*wf*3.1+vec2(99.1,5.7)))-0.5;
  return (w1+w2*0.35)*(uGridBB.z*float(${FX.warpAmp}));
}
/* 长波扭曲（只喂色调/材质查找；λ≈6 格、幅≈±0.85 格）：把多格涂改色块的直边揉出有机走向。
   有意超过半格——warpOf 守半格是为晕渲高程服务的，此形变不进高程，等高线/晕渲不受它影响 */
vec2 warp2Of(vec2 rel){
  float wf=float(${FX.warp2F})/uGridBB.z;
  vec2 lo=(vec2(vnoise2(rel*wf+vec2(3.9,71.3)), vnoise2(rel*wf+vec2(41.7,9.1)))-0.5)*(uGridBB.z*float(${FX.warp2Amp}));
  float hf=float(${FX.warp3F})/uGridBB.z;   // 边缘碎化：高频小幅，见 FX.warp3F 头注
  vec2 hi=(vec2(vnoise2(rel*hf+vec2(17.1,53.7)), vnoise2(rel*hf+vec2(88.3,25.9)))-0.5)*(uGridBB.z*float(${FX.warp3Amp}));
  return lo+hi;
}
/* 微八度：世界锚定 ×2 阶梯，逐档门控；振幅由调用方乘材质 rough。break 只依 uniform=控制流一致。
   持续度 <0.5=高频档法线贡献递减——0.5 时每档对坡面明暗等贡献，深放大十档叠出抓挠感。
   逐档旋转 37°（ROT）打散值噪声的网格各向异性——不旋则多档叠加呈梳毛状流纹 */
const mat2 ROT=mat2(0.7986,-0.6018,0.6018,0.7986);
float micro(vec2 rel){
  float s=0.0,a=0.5,f=MF0;
  vec2 p=rel;
  for(int k=0;k<${MICRO_OCTAVES};k++){
    float g=gate(f); if(g<=0.0) break;
    s+=a*g*(vnoise2(p*f+vec2(float(k)*19.7,float(k)*7.9))-0.5);
    p=ROT*p; f*=2.0; a*=float(${FX.microPers});
  }
  return s;
}
/* 材质纹理（只进光照法线）：各类一对 lod 档 crossfade；权重为零的类整段跳过——
   本函数产出不喂 fwidth，divergent 分支无害（e/es 的一致控制流纪律见 eAt/elevSmooth） */
float texAt(vec2 rel, vec4 tw){
  float h=0.0;
  if(tw.x>0.003){ vec3 L=lodF(float(${FX.canopyPx})); float g=gate(L.x);
    if(g>0.0){ float a=smoothstep(0.35,0.8,vnoise2(rel*L.x+vec2(7.7,3.1)));
      float b=smoothstep(0.35,0.8,vnoise2(rel*L.y+vec2(3.3,8.9)));
      h+=tw.x*float(${FX.canopyAmp})*g*mix(a,b,L.z); } }
  if(tw.y>0.003){ vec3 L=lodF(float(${FX.dunePx})); float g=gate(L.x);
    if(g>0.0){ float a=rg(gnoise2(vec2(rel.x*0.3,rel.y)*L.x+vec2(11.1,0.7)));
      float b=rg(gnoise2(vec2(rel.x*0.3,rel.y)*L.y+vec2(0.9,17.3)));
      h+=tw.y*float(${FX.duneAmp})*g*mix(a,b,L.z); } }
  if(tw.z>0.003){ vec3 L=lodF(float(${FX.ridgePx})); float g=gate(L.x);   // 棱脊两级：主脉（×0.36 波长）调制支脉=山系层级感
    if(g>0.0){ float m1=rg(gnoise2(rel*L.x*0.36+vec2(77.7,13.9)));
      float a=rg(gnoise2(rel*L.x+vec2(23.1,9.3)));
      float b=rg(gnoise2(rel*L.y+vec2(5.3,31.7)));
      float r=mix(a,b,L.z);
      h+=tw.z*float(${FX.ridgeAmp})*g*(0.55*m1*m1+0.45*m1*r); } }
  if(tw.w>0.003){ vec3 L=lodF(float(${FX.marshPx})); float g=gate(L.x);
    if(g>0.0){ float a=vnoise2(rel*L.x+vec2(41.3,2.9));
      float b=vnoise2(rel*L.y+vec2(3.7,55.1));
      h+=tw.w*float(${FX.marshAmp})*g*(mix(a,b,L.z)-0.5); } }
  return h;
}
/* 域扭曲后的四角双线性材质/色调（tint 缺项按权归一；出格靠 clamp 取边缘格，与 cellAt 的钳制同规） */
struct Mat { vec3 tint; float tintW; vec4 tw; float rough; float albVar; float rock; };
Mat matAt(vec2 rw){   // rw=已扭曲的局部坐标（调用方算一次 warp，与晕渲共用）
  vec2 f=rw/uGridBB.z-0.5;
  ivec2 c0=clamp(ivec2(floor(f)), ivec2(0), uGridDim-1);
  ivec2 c1=min(c0+1, uGridDim-1);
  vec2 t=clamp(f-vec2(c0), 0.0, 1.0);
  t=smoothstep(0.22,0.78,t);   // 过渡压窄到约半格：斑块边缘有机而不晕开
  vec4 w=vec4((1.0-t.x)*(1.0-t.y), t.x*(1.0-t.y), (1.0-t.x)*t.y, t.x*t.y);
  Mat m; m.tint=vec3(0.0); m.tintW=0.0; m.tw=vec4(0.0); m.rough=0.0; m.albVar=0.0; m.rock=0.0;
  for(int i=0;i<4;i++){
    ivec2 cc=ivec2((i==1||i==3)?c1.x:c0.x, (i>=2)?c1.y:c0.y);
    int ti=int(texelFetch(uGrid,cc,0).g+0.5);
    float wi=w[i];
    vec3 tn=uTint[ti];
    if(tn.x>=0.0){ m.tint+=tn*(wi/255.0); m.tintW+=wi; }
    m.tw+=uMatA[ti]*wi;
    vec4 mb=uMatB[ti];
    m.rough+=mb.x*wi; m.albVar+=mb.y*wi; m.rock+=mb.z*wi;
  }
  if(m.tintW>0.0) m.tint/=m.tintW;
  return m;
}

vec2 cellAt(vec2 ll){ // (双线性高程, 最近格类型索引)——高程走细分场纹理、类型仍粗格最近取
  // 网格 bbox 之外=深海（对齐 CPU 兜底先铺深水的行为；用真实跨度而非 cols×step——后者 ceil 多出 <1 格边缘条带）。
  // 纸模式（战术图）出界改走 clamp 延伸＝CPU elevBilinear 同语义：图幅外没有海，域扭曲把边缘采样点
  // 推出图幅时不得掉进深水（否则图廓内侧随 warp 场亮出断续蓝斑）
  vec2 rel=ll-uGridBB.xy;
  if(uPaper==0 && (rel.x<0.0||rel.y<0.0||rel.x>uGridSpan.x||rel.y>uGridSpan.y)) return vec2(SEA_E, SEA_T);
  vec2 f=rel/uFStep-0.5;
  ivec2 c0=clamp(ivec2(floor(f)), ivec2(0), uFDim-1);
  ivec2 c1=min(c0+1, uFDim-1);
  vec2 t=clamp(f-vec2(c0), 0.0, 1.0);
  float e00=texelFetch(uField,ivec2(c0.x,c0.y),0).r, e10=texelFetch(uField,ivec2(c1.x,c0.y),0).r;
  float e01=texelFetch(uField,ivec2(c0.x,c1.y),0).r, e11=texelFetch(uField,ivec2(c1.x,c1.y),0).r;
  float top=e00+(e10-e00)*t.x, bot=e01+(e11-e01)*t.x;
  ivec2 n=clamp(ivec2(floor(rel/uGridBB.z)), ivec2(0), uGridDim-1);
  return vec2(top+(bot-top)*t.y, texelFetch(uGrid,n,0).g);
}
float occAt(vec2 ll){ // 烘焙遮蔽双线性（uField G；粗格全零＝无影响；出幅=0）
  vec2 rel=ll-uGridBB.xy;
  if(rel.x<0.0||rel.y<0.0||rel.x>uGridSpan.x||rel.y>uGridSpan.y) return 0.0;
  vec2 f=rel/uFStep-0.5;
  ivec2 c0=clamp(ivec2(floor(f)), ivec2(0), uFDim-1);
  ivec2 c1=min(c0+1, uFDim-1);
  vec2 t=clamp(f-vec2(c0), 0.0, 1.0);
  float o00=texelFetch(uField,ivec2(c0.x,c0.y),0).g, o10=texelFetch(uField,ivec2(c1.x,c0.y),0).g;
  float o01=texelFetch(uField,ivec2(c0.x,c1.y),0).g, o11=texelFetch(uField,ivec2(c1.x,c1.y),0).g;
  float top=o00+(o10-o00)*t.x, bot=o01+(o11-o01)*t.x;
  return top+(bot-top)*t.y;
}
/* 高程细节场：双线性数据面 + 宏观 fbm4（旧式逐位）+ 微八度；dk=装饰噪声门（判据见 material.decoGate） */
float eAt(vec2 ll, float mrough, float dk){
  float e=cellAt(ll).x;
  float rough=e>0.4?0.24:(e>0.2?0.08:0.025);
  e+=(fbm4(ll*1.1)-0.5)*rough*2.0*dk;
  return e+micro(ll-uGridBB.xy)*mrough*float(${FX.microAmp})*dk;
}
float elevSmooth(vec2 ll){ // 制图面：±半场格 4 抽头帐篷平滑（与 core/elev.elevSmooth 同式——读数=线；细分场即半细格）
  float h=0.5*uFStep;
  return 0.25*(cellAt(ll+vec2(-h,-h)).x+cellAt(ll+vec2(h,-h)).x+cellAt(ll+vec2(-h,h)).x+cellAt(ll+vec2(h,h)).x);
}
/* 等高线助手：d=到最近整倍等值面的像素距（数值 +1e-6 防零梯度平台整面刷线）。
   cwMinor/cwIndex 带宽不同（计曲线加宽）；oddK=倍数奇偶（×2 阶梯过渡期只淡入奇数倍新线） */
float cwMinor(float eh,float itv,float aa){ float u=eh/itv; float d=(abs(u-round(u))*itv+1e-6)/aa; return 1.0-smoothstep(0.8,1.5,d); }
float cwIndex(float eh,float itv,float aa){ float u=eh/itv; float d=(abs(u-round(u))*itv+1e-6)/aa; return 1.0-smoothstep(1.3,2.4,d); }
float oddK(float eh,float itv){ return mod(round(eh/itv),2.0); }
vec3 elevRamp(float e){
  if(e<-0.02){ float t=clamp((e+0.35)/0.33,0.0,1.0); return vec3(40.0+t*60.0,90.0+t*70.0,132.0+t*66.0)/255.0; }
  if(e<0.09) return vec3(214.0,205.0,168.0)/255.0;   // 滩带压灰半档（原 224,216,172 在整幅下发白光）
  if(e<0.30){ float t=(e-0.09)/0.21; return vec3(132.0+t*38.0,174.0-t*2.0,98.0+t*12.0)/255.0; }
  if(e<0.55){ float t=(e-0.30)/0.25; return vec3(170.0+t*8.0,166.0-t*12.0,110.0-t*4.0)/255.0; }
  if(e<0.82){ float t=(e-0.55)/0.27; return vec3(178.0-t*28.0,152.0-t*24.0,118.0-t*22.0)/255.0; }
  // 顶带收灰岩（原顶带冲到 240,236,242 的雪白＝雪与岩混为一谈；雪自此按米另落，见 uSnowE）
  float t=min(1.0,(e-0.82)/0.30); return vec3(140.0+t*62.0,132.0+t*66.0,124.0+t*70.0)/255.0;
}
void main(){
  float x=gl_FragCoord.x-0.5, yTop=uRes.y-gl_FragCoord.y-0.5;   // 与 CPU 版角点采样对齐
  vec2 ll=vec2(uViewBB.x+x/uPXPD, uViewBB.w-yTop/uPXPDY);
  // 球面环绕：经度折回以网格中心为轴的 ±180° 域——单次绘制即无缝跨越 ±180° 经线
  if(uWrap==1) ll.x-=360.0*floor((ll.x-uGridBB.w+180.0)/360.0);
  vec2 cd=cellAt(ll);   // (双线性数据面高程, 最近格类型索引)：等高线/诊断用，晕渲另走带噪声的 eAt
  if(uMode==1){ int ti=int(cd.y+0.5); fragColor=vec4(uTColor[ti],1.0); return; }
  float px=1.0/uPXPD, py=1.0/uPXPDY;
  vec2 rel=ll-uGridBB.xy;
  /* 域扭曲一次共用：色调/材质查找与晕渲高程同一形变（涂改方块的直角沟壑随之弯成有机走向）。
     等高线/光标读数仍走未扭曲制图面 es——「晕渲是画、等高线是尺」，画可以形变，尺不动。
     邻点采样共用中心 warp（波长≈1.3 格≫1px，雅可比≈常数，法线误差可忽略）。 */
  vec2 wp=warpOf(rel);
  vec2 llw=ll+wp;
  Mat mt=matAt(rel+wp+warp2Of(rel));   // 色调/材质权重中心取一次，五点采样共用（边界差 1px 可忽略）
  /* 宏观场坡先行（±1 格、无噪声）：①光照里再计一份基础坡，压低噪声皱纹话语权；
     ②陡处按坡度补糙度/棱脊——手雕高山常落在平原类型上，材质只认类型＝草地质感的光滑圆包 */
  vec2 mgv=vec2(cellAt(llw+vec2(-uGridBB.z,0.0)).x-cellAt(llw+vec2(uGridBB.z,0.0)).x,
                cellAt(llw+vec2(0.0,uGridBB.z)).x-cellAt(llw+vec2(0.0,-uGridBB.z)).x);
  float smac=length(mgv)/(2.0*uGridBB.z);   // |∇e| 每度
  float roughEff=max(mt.rough, min(float(${FX.slopeRoughMax}), smac*float(${FX.slopeRough})));
  vec4 twEff=vec4(mt.tw.xy, max(mt.tw.z, min(1.0, smac*float(${FX.slopeRidge}))), mt.tw.w);
  // 屏幕锚定纹理的幅度按 1/像素密度折算（明暗对比恒定不随缩放）× 陡坡增纹（见 FX.texSlope 头注）
  float texW=float(${FX.texW})/uPXPD*(1.0+min(float(${FX.texSlopeMax}), max(0.0, smac-float(${FX.texSlopeLo}))*float(${FX.texSlope})));
  // 纹理疏密：世界锚定两八度低频调制（见 FX.texPatchF 头注）——五点采样共用此 texW，故不添假坡
  float pf=float(${FX.texPatchF})/uGridBB.z;
  float pn=0.65*vnoise2(rel*pf+vec2(19.3,5.7))+0.35*vnoise2(rel*pf*2.7+vec2(63.1,28.9));
  texW*=mix(float(${FX.texPatchLo}), float(${FX.texPatchHi}), smoothstep(0.32,0.68,pn));
  // 装饰噪声门（decoGate 同式；land 平滑过渡防岸线阶跃；fine 纯 uniform=一致控制流,粗格恒 1）
  float fine=uFStep<uGridBB.z*0.999?1.0:0.0;
  float dk0=max(smoothstep(float(${FX.decoSlopeLo}),float(${FX.decoSlopeHi}),smac),
                smoothstep(float(${FX.decoRoughLo}),float(${FX.decoRoughHi}),mt.rough));
  float decoK=1.0+(dk0-1.0)*smoothstep(-0.02,0.02,cd.x)*fine;
  float e  =eAt(llw, roughEff, decoK);
  float eL=eAt(llw+vec2(-px,0.0),roughEff,decoK)+texAt(rel+vec2(-px,0.0),twEff)*texW;
  float eR=eAt(llw+vec2( px,0.0),roughEff,decoK)+texAt(rel+vec2( px,0.0),twEff)*texW;
  float eU=eAt(llw+vec2(0.0, py),roughEff,decoK)+texAt(rel+vec2(0.0, py),twEff)*texW;
  float eD=eAt(llw+vec2(0.0,-py),roughEff,decoK)+texAt(rel+vec2(0.0,-py),twEff)*texW;
  float nrm=4.5*(uPXPD/14.0);
  vec3 nv=vec3((eL-eR)*nrm,(eU-eD)*nrm,1.0);
  /* 0.3214=nrm 对基础坡度的响应系数之半（2·nrm/uPXPD ÷2），两套法线同量纲可直接相加 */
  float mnk=0.3214/uGridBB.z*float(${FX.macroW});
  vec2 mn=mgv*mnk;
  /* 暖冷晕渲（Imhof）：受光面暖、背光面冷紫，软肩响应拉开明暗——旧 0.6+0.75·d 线性乘法
     最亮:最暗仅 2.2:1，整图无深度。总坡度过陡坡软压（见 FX.slopeKnee 注）再进光照 */
  /* ⚠ 别把「细节从软压里摘出来单独叠」当成救药（2026-08-08 试过并撤回）：软压是**径向重标定**
     sv=f(|v|)·v̂，细节与宏观被同一系数缩放＝比例不变，它并不偏向压制细节；(soft/(soft+sx))²
     只是**径向**扰动的衰减率，而纹理扰动几乎全是切向的。摘出来反而使 |sv| 小于 slc＝全局对比塌，
     实拍各机位全频段一致降 3~30%（河洛高章区最重）。陡坡纹理看不见的真因是宏观坡本身 90/度
     而细节量级≈1，比例悬殊 90:1——那是数据侧的类型台阶，要治得去治台阶，不是在光照里补 */
  vec2 sv=nv.xy+mn;
  float sl=length(sv);
  float sx2=max(0.0,sl-float(${FX.slopeKnee}));
  float slc=float(${FX.slopeKnee})+sx2*float(${FX.slopeSoft})/(float(${FX.slopeSoft})+sx2);
  float dn=dot(normalize(vec3(sv*(sl>1e-6? slc/sl : 1.0),1.0)), uLight);
  float lt=smoothstep(float(${FX.shadeKnee}),1.0,dn);
  lt*=1.0-occAt(llw)*float(${FX.shadowK});   // 烘焙投影阴影：背光谷底连同暖冷响应一起压暗（粗格全零）
  float sh=mix(float(${FX.shadeLo}),float(${FX.shadeHi}),lt);
  vec3 shT=mix(vec3(${FX.cool.join(",")}),vec3(${FX.warm.join(",")}),lt);
  float es=elevSmooth(ll);      // 制图面（帐篷平滑数据面，与光标读数同源）；导数须在一致控制流取（分支内 fwidth 未定义，软渲返 0）
  float cav=clamp((es-cd.x)*float(${FX.cavAmp}), -0.10, 0.16);   // 帐篷差≈曲率：谷暗脊明（廉价 AO）
  vec3 col=elevRamp(e);
  if(e>=-0.02){
    if(mt.tintW>0.0) col=mix(col, mt.tint, 0.45*mt.tintW);   // 软过渡；tintW=1 时与旧 55/45 直拼逐位同值
    // 生态辨识度：荒漠暖沙定调；沼泽湿绿+近景水洼/湿泥（键=材质权重 tw.y/tw.w，详见 material.ts）
    col=mix(col, vec3(${FX.sandC.join(",")}), mt.tw.y*float(${FX.sandMix}));
    if(mt.tw.w>0.003){
      col=mix(col, vec3(${FX.marshC.join(",")}), mt.tw.w*float(${FX.marshMix}));
      float pg=smoothstep(float(${FX.poolLo}),float(${FX.poolHi}),uPXPD)*mt.tw.w;
      if(pg>0.003){
        float pn=vnoise2(rel*(float(${FX.poolF})/uGridBB.z)+vec2(7.3,3.9));
        float pw=smoothstep(0.58,0.68,pn);
        col=mix(col, vec3(${FX.mudC.join(",")}), smoothstep(0.40,0.58,pn)*(1.0-pw)*pg*float(${FX.mudMix}));
        col=mix(col, vec3(${FX.poolC.join(",")}), pw*pg*float(${FX.poolMix}));
      }
    }
    vec3 LA=lodF(float(${FX.albPx}));   // 反照率抖动：屏幕锚定低频，打破平色（整幅视角下门控为零）
    float av=mix(vnoise2(rel*LA.x+vec2(19.9,7.1)), vnoise2(rel*LA.y+vec2(2.3,27.9)), LA.z)-0.5;
    col*=1.0+av*mt.albVar*float(${FX.albAmp})*gate(LA.x);
    float slp=length(nv.xy);    // 缩放无关坡度：陡处露岩（微八度让坡度随放大长细节，岩斑自然斑驳）
    float rk=smoothstep(0.55,1.6,slp)*mt.rock;
    vec3 rockC=mix(vec3(0.36,0.33,0.30), vec3(0.62,0.60,0.57), clamp(e*1.1,0.0,1.0));
    col=mix(col, rockC, rk*float(${FX.rockMix}));
    // 雪按米落（uSnowE=material.snowEOf 折算；陡坡挂不住雪打六折）——色阶顶带只剩灰岩，白色归雪
    float sn=smoothstep(uSnowE,uSnowE+float(${FX.snowBand}),e)*(1.0-0.6*smoothstep(0.9,1.8,slp));
    col=mix(col, vec3(0.93,0.94,0.965), sn);
    col*=sh*shT*(1.0-cav);
  } else {
    // 近岸浅水带：随缩放渐隐（px/° 区间见 FX.shoreLo/Hi）——整幅视角下固定高程区间摊成贴纸大光环
    float shore=smoothstep(-0.10,-0.02,e)*smoothstep(float(${FX.shoreLo}),float(${FX.shoreHi}),uPXPD);
    col=mix(col, vec3(0.55,0.72,0.75), shore*float(${FX.shoreMix}));
    vec3 LW=lodF(float(${FX.wavePx}));  // 静态波纹（横向拉伸；无动画，尊重空闲降频）
    float wv=mix(ridged(vnoise2(vec2(rel.x*0.35,rel.y)*LW.x+vec2(3.1,9.7))),
                 ridged(vnoise2(vec2(rel.x*0.35,rel.y)*LW.y+vec2(21.3,1.1))), LW.z);
    col*=1.0+(wv-0.5)*float(${FX.waveAmp})*gate(LW.x);
  }
  float aa=fwidth(e)+1e-6;
  float ad=fwidth(es)+1e-7;
  float coast=1.0-smoothstep(0.0, aa*1.4, abs(e+0.02));
  col=mix(col, vec3(38.0,66.0,86.0)/255.0, coast*0.55);
  // 网格内缩一格的图幅裁边：世界 bbox 外=深海，制图面在边缘塌向海——贴边假线截掉（neatline 惯例）
  if(uContour==1 && es>=-0.02 && rel.x>uGridBB.z && rel.y>uGridBB.z && rel.x<uGridSpan.x-uGridBB.z && rel.y<uGridSpan.y-uGridBB.z){
    // 等高线画在制图面 es（晕渲是画，等高线是尺）。细曲线=当前档整倍+半档奇数倍×uCFade 淡入；计曲线=每第 4 条。
    // 挤线抑制（真图规范）：线距不足数像素的陡坎处细曲线隐去；计曲线按自身 4× 线距评估而幸存。
    float eh=es+0.02;
    float mn=max(cwMinor(eh,uCMinor,ad), cwMinor(eh,uCMinor*0.5,ad)*oddK(eh,uCMinor*0.5)*uCFade);
    float ix=max(cwIndex(eh,uCMinor*4.0,ad), cwIndex(eh,uCMinor*2.0,ad)*oddK(eh,uCMinor*2.0)*uCFade);
    float sup=smoothstep(2.5,6.0,uCMinor/ad), supIx=smoothstep(2.5,6.0,uCMinor*4.0/ad);
    col=mix(col, vec3(90.0,70.0,40.0)/255.0, max(mn*0.50*sup, ix*0.70*supIx));
  }
  // 图幅外纸色最后覆盖（放在全部计算之后＝fwidth 的一致控制流不受此分支影响）；图廓线由 overlay 层描
  if(uPaper==1 && (rel.x<0.0||rel.y<0.0||rel.x>uGridSpan.x||rel.y>uGridSpan.y)) col=vec3(217.0,210.0,192.0)/255.0;
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
  let tex: WebGLTexture | null = null;    // 类型粗格纹理（TEXTURE0）
  let ftex: WebGLTexture | null = null;   // 高程场+遮蔽纹理（TEXTURE1；侵蚀细分后维度 ≠ 粗格）
  let g: Grid | null = null;
  let lastField: ElevField | undefined;   // 存最近高程场：上下文丢失恢复时重传
  const U = (n: string) => gl.getUniformLocation(pr!, n);

  /* 建程序 + 设常量 uniform（创建时 + webglcontextrestored 后重跑）。 */
  function initProgram(): boolean {
    pr = compileProgram(gl);
    if (!pr) return false;
    gl.useProgram(pr);
    gl.uniform1i(U("uGrid"), 0);
    gl.uniform1i(U("uField"), 1);
    const light = [-0.6, -0.6, 0.9], ll = Math.hypot(...light);
    gl.uniform3f(U("uLight"), light[0] / ll, light[1] / ll, light[2] / ll);
    const comps = allComposites();   // 25 个复合，顺序与 compositeIndex 对齐（旧 8 类落在各自复合上、色/tint 逐位复现）
    gl.uniform3fv(U("uTColor[0]"), comps.flatMap(cc => hexV(terrainProps(cc).color)));
    gl.uniform3fv(U("uTint[0]"), comps.flatMap(cc => { const t = terrainProps(cc).tint; return t ? [t[0], t[1], t[2]] : [-1, -1, -1]; }));
    const mats = materialTable();    // 渲染材质（同序；render/material.ts 真源，CPU 兜底同表）
    gl.uniform4fv(U("uMatA[0]"), mats.flatMap(m => [m.canopy, m.dune, m.ridge, m.marsh]));
    gl.uniform4fv(U("uMatB[0]"), mats.flatMap(m => [m.rough, m.albVar, m.rock, 0]));
    return true;
  }
  function doUpload(grid: Grid, field?: ElevField) {
    if (!pr) return;
    if (tex) gl.deleteTexture(tex);
    if (ftex) gl.deleteTexture(ftex);
    /* 类型粗格纹理：G=复合索引 lf*5+eco（R 弃用恒 0——高程自此一律走场纹理） */
    const data = new Float32Array(grid.cols * grid.rows * 2);
    for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
      const i = (r * grid.cols + c) * 2;
      data[i + 1] = compositeIndex(grid.cells[r][c]);
    }
    tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, grid.cols, grid.rows, 0, gl.RG, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    /* 高程场纹理：R=高程 G=遮蔽（未传场＝按类型合成粗格，旧行为；遮蔽全零） */
    const fc = field ? field.cols : grid.cols, fr = field ? field.rows : grid.rows;
    const fd = new Float32Array(fc * fr * 2);
    if (field) {
      for (let k = 0; k < fc * fr; k++) { fd[k * 2] = field.data[k]; fd[k * 2 + 1] = field.shadow ? field.shadow[k] : 0; }
    } else {
      for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) fd[(r * grid.cols + c) * 2] = terrainProps(grid.cells[r][c]).elev;
    }
    ftex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ftex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, fc, fr, 0, gl.RG, gl.FLOAT, fd);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);   // 常规活动纹理还原到 0 号（后续 doUpload 的类型纹理绑定预期）
    gl.uniform4f(U("uGridBB"), grid.bb.lonMin, grid.bb.latMin, grid.step, (grid.bb.lonMin + grid.bb.lonMax) / 2);
    gl.uniform2i(U("uGridDim"), grid.cols, grid.rows);
    gl.uniform2i(U("uFDim"), fc, fr);
    gl.uniform1f(U("uFStep"), field ? field.step : grid.step);
    gl.uniform2f(U("uGridSpan"), grid.bb.lonMax - grid.bb.lonMin, grid.bb.latMax - grid.bb.latMin);
  }

  if (!initProgram()) return null;   // 探针过后此处基本必过；稳妥兜底

  /* 上下文丢失/恢复（GPU 进程崩溃、驱动重置、后台标签回收）：
     preventDefault 才有 restored；恢复后 program/纹理全失效，重建并重传网格——
     下一帧 rAF 自动出图，外壳零改动。缺此则地形永久空白（审计）。 */
  const onLost = (e: Event) => { e.preventDefault(); };
  const onRestored = () => { tex = null; ftex = null; if (initProgram() && g) doUpload(g, lastField); };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    canvas, kind: "webgl2",
    uploadGrid(grid: Grid, field?: ElevField) { g = grid; lastField = field; doUpload(grid, field); },
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
      gl.uniform1i(U("uPaper"), opts.paper ? 1 : 0);
      gl.uniform1f(U("uSnowE"), opts.snowE ?? 1e9);
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
      if (ftex) gl.deleteTexture(ftex);
      if (pr) gl.deleteProgram(pr);
    }
  };
}
