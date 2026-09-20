/* WebGL2 地形渲染器。
   职责边界：分类网格（游戏真源）由 core/grid 在 CPU 计算、作为 RG32F 纹理上传（R=示意高程 G=类型索引）；
   本模块只做像素观感——高程双线性 + 细节噪声 + 晕渲 + 色阶 + 生态色调 + 海岸线 + 等高线。
   等高线例外地画在**规则场（工作档）的无噪声制图面**上（画面场可为精修档，线不跟它＝与读数同一个数）：
   首曲线+计曲线（每第 5 条），等距由 core/elev.contourStepFor 随缩放与地势在 1-2-5 阶梯上自适应，相邻两档（uCA 细 / uCB 粗）
   按 uCFade 交叉淡入淡出；像素量按 uDPR 锚 CSS 像素。
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
import { materialTable, rampGLSL, snowLatGLSL, MICRO_F0, MICRO_OCTAVES, NRM0, FX } from "./material.ts";
import type { Grid } from "../core/grid.ts";
import { SUP_DASH_PX, SUP_HI_PX, SUP_LO_PX, type ElevField } from "../core/elev.ts";
import type { BBox } from "../core/types.ts";

const VS = `#version 300 es
void main(){ vec2 p=vec2(float(gl_VertexID<<1&2), float(gl_VertexID&2)); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;

const FS = `#version 300 es
precision highp float; precision highp int;
const float SEA_E=float(${ELEV.water});                        // 深海高程（构建期注入，与 core 常量同源）
const float SEA_T=float(${compositeIndex("water")});           // water 复合索引（G 通道）
uniform sampler2D uGrid;          // RG32F: R=水面高程(海 0/内陆湖岸线高) G=复合索引(lf*5+eco)——均粗格最近取
uniform sampler2D uField;         // RG32F: R=高程场 G=定向遮蔽 0..1（粗格=coarseField 全零；细分=erode 产出）
uniform vec4 uGridBB;             // lonMin,latMin,step,wrap中心经度
uniform ivec2 uGridDim;           // cols,rows（类型粗格）
uniform ivec2 uFDim;              // 高程场维度（侵蚀细分后 ≠ uGridDim）
uniform float uFStep;             // 度/场格
uniform sampler2D uRule;          // RG32F 规则场（工作档）：等高线只从它取样＝与光标读数同源；画面场为精修档时线不跟画面
uniform ivec2 uRDim;              // 规则场维度
uniform float uRStep;             // 度/规则场格
uniform vec2 uGridSpan;           // 网格真实跨度(lonMax-lonMin,latMax-latMin)：出界判定用，对齐 CPU/旧版 bbox
uniform vec4 uViewBB;             // lonMin,latMin,lonMax,latMax
uniform vec2 uRes;                // 画布像素
uniform float uPXPD;              // 横向像素/度（经度有 cos(lat0) 校正，与纵向不同）
uniform float uPXPDY;             // 纵向像素/度（对齐旧 drawTile 经 project 的各向异性贴图）
uniform float uCA, uCB;           // 两套线系的等距（抽象单位；contourStepFor：1-2-5 阶梯上相邻两档，A 细 B 粗）
uniform float uCFade;             // B 系权重 0..1（两系交叉淡入淡出；A==B 时无效）
uniform float uDPR;               // 设备像素比：等高线线宽、挤线门、间曲线门与虚线节距按 CSS 像素锚定（1＝逐位旧行为）
uniform vec3 uLight;
uniform int uMode;                // 0=观感底图 1=推演底图（逐格平色）
uniform int uContour;
uniform int uWrap;                // 1=球面经度环绕（把片元经度折回世界本初域），0=平面
uniform int uPaper;               // 1=图幅外铺宣纸色（战术图；色=出图垫纸色 #d9d2c0 同源）
uniform float uSnowE;             // 雪线抽象高程（图幅中心；material.snowSpec.base；不落雪=1e9）
uniform float uSnowLat, uSnowRef, uSnowUnit;   // 随纬度：开关 0/1（球面图且设了气候档）、参考曲线在中心纬度的米值、1/elevUnitM
uniform float uGain;              // 晕渲法线增益（material.shadeGain：夸张 E∈[4,8] 倍真实坡度）
uniform float uEroded;            // 1=场经侵蚀（带遮蔽通道）：装饰噪声按坡门控、宏观 fbm4 降到四分之一——真形自己带起伏
uniform vec3 uTColor[${COMPOSITE_COUNT}];   // 各复合平色＝terrainProps.color（推演底图用；G=lf*5+eco 索引）
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
/* 出界判据看**未扭曲**位置：gWarp＝当前采样族的域扭曲量（main 里扭曲族置 wp、制图面族置 0）。
   按扭曲后的点判，贴边像素被推出图幅就掉进深海、图幅外的被推进来就长出陆地＝图廓两侧各啃一圈锯齿。 */
vec2 gWarp=vec2(0.0);
bool outside(vec2 rel){ vec2 u=rel-gWarp; return u.x<0.0||u.y<0.0||u.x>uGridSpan.x||u.y>uGridSpan.y; }
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
    if(g>0.0){ float a=vnoise2(rel*L.x+vec2(7.7,3.1))-0.5;   // 软鼓包（阈值化＝迷宫蠕虫纹）
      float b=vnoise2(rel*L.y+vec2(3.3,8.9))-0.5;
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

/* 场纹理双线性（格心对齐、边缘 clamp；出界判定由调用方做）：.x=高程 R，.y=遮蔽 G */
vec2 fieldBil(sampler2D fld, ivec2 dim, float st, vec2 rel){
  vec2 f=rel/st-0.5;
  ivec2 c0=clamp(ivec2(floor(f)), ivec2(0), dim-1);
  ivec2 c1=min(c0+1, dim-1);
  vec2 t=clamp(f-vec2(c0), 0.0, 1.0);
  vec2 s00=texelFetch(fld,ivec2(c0.x,c0.y),0).rg, s10=texelFetch(fld,ivec2(c1.x,c0.y),0).rg;
  vec2 s01=texelFetch(fld,ivec2(c0.x,c1.y),0).rg, s11=texelFetch(fld,ivec2(c1.x,c1.y),0).rg;
  vec2 top=s00+(s10-s00)*t.x, bot=s01+(s11-s01)*t.x;
  return top+(bot-top)*t.y;
}
vec2 cellAt(vec2 ll){ // (双线性画面场高程, 最近格类型索引)——高程走细分场纹理、类型仍粗格最近取
  // 网格 bbox 之外=深海（对齐 CPU 兜底先铺深水的行为；用真实跨度而非 cols×step——后者 ceil 多出 <1 格边缘条带）。
  // 纸模式（战术图）出界改走 clamp 延伸＝CPU elevBilinear 同语义：图幅外没有海。
  vec2 rel=ll-uGridBB.xy;
  if(uPaper==0 && outside(rel)) return vec2(SEA_E, SEA_T);
  ivec2 n=clamp(ivec2(floor(rel/uGridBB.z)), ivec2(0), uGridDim-1);
  return vec2(fieldBil(uField,uFDim,uFStep,rel).x, texelFetch(uGrid,n,0).g);
}
float occAt(vec2 ll){ // 烘焙遮蔽双线性（画面场 G；粗格全零＝无影响；出幅=0）
  vec2 rel=ll-uGridBB.xy;
  if(outside(rel)) return 0.0;
  return fieldBil(uField,uFDim,uFStep,rel).y;
}
float ruleAt(vec2 ll){ // 规则场（工作档）双线性高程：等高线的唯一采样源；出界语义同 cellAt
  vec2 rel=ll-uGridBB.xy;
  if(uPaper==0 && outside(rel)) return SEA_E;
  return fieldBil(uRule,uRDim,uRStep,rel).x;
}
/* 高程细节场：双线性数据面 + 宏观 fbm4（旧式逐位）+ 微八度；dk=装饰噪声门（判据见 material.decoGate） */
float eAt(vec2 ll, float mrough, float dk){
  float e=cellAt(ll).x;
  float rough=(e>0.4?0.24:(e>0.2?0.08:0.025))*mix(1.0,0.25,uEroded);
  e+=(fbm4(ll*1.1)-0.5)*rough*2.0*dk;
  return e+micro(ll-uGridBB.xy)*mrough*float(${FX.microAmp})*dk;
}
float elevSmooth(vec2 ll){ // 画面场制图面：±半场格 4 抽头帐篷平滑（与 core/elev.elevSmooth 同式）；只喂谷影
  float h=0.5*uFStep;
  return 0.25*(cellAt(ll+vec2(-h,-h)).x+cellAt(ll+vec2(h,-h)).x+cellAt(ll+vec2(-h,h)).x+cellAt(ll+vec2(h,h)).x);
}
float ruleSmooth(vec2 ll){ // 规则场制图面：同式换源——等高线画在它上＝与光标读数同一个数（画面场为精修档时线不跟画面）
  float h=0.5*uRStep;
  return 0.25*(ruleAt(ll+vec2(-h,-h))+ruleAt(ll+vec2(h,-h))+ruleAt(ll+vec2(-h,h))+ruleAt(ll+vec2(h,h)));
}
/* 等高线助手：d=到最近整倍等值面的像素距（数值 +1e-6 防零梯度平台整面刷线）。
   cwMinor/cwIndex 带宽不同（计曲线加宽），bo=带宽外扩像素（亮晕用同一带外扩）；oddK=倍数奇偶（只淡入奇数倍新线） */
float cwMinor(float eh,float itv,float aa,float bo){ float u=eh/itv; float d=(abs(u-round(u))*itv+1e-6)/aa; return 1.0-smoothstep(0.8+bo,1.5+bo,d); }
float cwIndex(float eh,float itv,float aa,float bo){ float u=eh/itv; float d=(abs(u-round(u))*itv+1e-6)/aa; return 1.0-smoothstep(1.3+bo,2.4+bo,d); }
float oddK(float eh,float itv){ return mod(round(eh/itv),2.0); }
/* 一套线系在此像素的着墨（CPU contourK 同式）：首曲线（挤线抑制：线距不足数像素的陡坎隐去）、计曲线（每第 5 条，按自身线距评估而幸存）、
   间曲线（1/2 距，长虚线）与助曲线（1/4 距，短虚线）——上一级线距 ≥ core/elev.SUP_* 才浮现，奇数倍＝只补首曲线之间的新线。
   gsl=粗坡（高程/CSS 像素）、sdp=沿等值线切向的像素坐标（虚线相位） */
float contourK(float eh,float itv,float aa,float gsl,float sdp,float bo){
  float mn=cwMinor(eh,itv,aa,bo)*smoothstep(2.5,6.0,itv/aa);
  float ix=cwIndex(eh,itv*5.0,aa,bo)*smoothstep(2.5,6.0,itv*5.0/aa);
  float sp1=itv/gsl;
  float g1=smoothstep(${SUP_LO_PX.toFixed(1)},${SUP_HI_PX.toFixed(1)},sp1), g2=g1*smoothstep(${SUP_LO_PX.toFixed(1)},${SUP_HI_PX.toFixed(1)},sp1*0.5);
  float sd=sdp/${SUP_DASH_PX.toFixed(1)};
  float d1=step(0.125,abs(fract(sd)-0.5)), d2=step(0.25,abs(fract(sd*2.0)-0.5));
  float m2=cwMinor(eh,itv*0.5,aa,bo)*oddK(eh,itv*0.5)*g1*d1;
  float m4=cwMinor(eh,itv*0.25,aa,bo)*oddK(eh,itv*0.25)*g2*d2;
  return max(max(mn*0.50, ix*0.70), max(m2*0.50, m4*0.42));
}
/* 两套线系按 uCFade 交叉淡入后的着墨（共有的线两系相加＝恒满） */
float inkK(float eh,float aa,float gsl,float sdp,float bo){
  return uCA==uCB ? contourK(eh,uCA,aa,gsl,sdp,bo) : min(1.0, contourK(eh,uCA,aa,gsl,sdp,bo)*(1.0-uCFade)+contourK(eh,uCB,aa,gsl,sdp,bo)*uCFade);
}
/* 水面高程（粗格最近取，同类型索引）：海=0，内陆湖=岸线高度，陆格取相邻水体水面
   （core/elev.waterSurface 已晕开一格＝湖岸线随细分场摆动，不被粗格边切成方块）。
   图幅外恒 0＝按海处理，与 cellAt 出界返 SEA_E 同调。 */
float wsAt(vec2 ll){
  vec2 rel=ll-uGridBB.xy;
  if(outside(rel)) return 0.0;
  ivec2 n=clamp(ivec2(floor(rel/uGridBB.z)), ivec2(0), uGridDim-1);
  return texelFetch(uGrid,n,0).r;
}
${rampGLSL()}
${snowLatGLSL()}
vec3 elevRamp(float e,float ws){
  if(e<ws-0.02){ float t=clamp((e-ws+0.35)/0.33,0.0,1.0); return vec3(40.0+t*60.0,90.0+t*70.0,132.0+t*66.0)/255.0; }
  return elevLand(e);   // 陆地分层设色＝material.ELEV_RAMP 一张表（CPU 同源）
}
void main(){
  float x=gl_FragCoord.x-0.5, yTop=uRes.y-gl_FragCoord.y-0.5;   // 与 CPU 版角点采样对齐
  vec2 ll=vec2(uViewBB.x+x/uPXPD, uViewBB.w-yTop/uPXPDY);
  // 球面环绕：经度折回以网格中心为轴的 ±180° 域——单次绘制即无缝跨越 ±180° 经线
  if(uWrap==1) ll.x-=360.0*floor((ll.x-uGridBB.w+180.0)/360.0);
  vec2 cd=cellAt(ll);   // (双线性画面场高程, 所在格类型索引)：推演平色与谷影用，晕渲另走带噪声的 eAt
  vec2 rel=ll-uGridBB.xy;
  float es=elevSmooth(ll);   // 画面场制图面（谷影的帐篷差；未扭曲族，此时 gWarp 恒 0）
  float er=ruleSmooth(ll);   // 规则场制图面＝等高线的尺（与光标读数同源；观感底图的画面场可为精修档，线不跟它）
  float ad=fwidth(er)*uDPR+1e-7;  // 等高线线宽（CSS 像素锚定）：两种底图共用，故在 uMode 分支之前取（分支内 fwidth 未定义，软渲返 0）
  vec2 gd=vec2(dFdx(er),dFdy(er));   // 规则场制图面屏幕梯度（间曲线沿等值线切虚线）；与 fwidth 同处取＝一致控制流
  vec3 col; float ws, e;
  if(uMode==1){
    /* 推演底图：所在格的类型平色（uTColor＝terrainProps.color），不扭曲、不晕渲、不铺纹理——
       像素的颜色就是光标读数与寻路读到的那一格；等高线与纸色在下方照画 */
    ws=wsAt(ll); e=cd.x;
    // 图幅外＝深海（同 CPU 兜底的底色；水域格的浅蓝只给格子，图幅界才看得见）；纸模式由末尾纸色覆盖
    col=outside(rel) ? vec3(40.0,90.0,132.0)/255.0 : uTColor[int(cd.y+0.5)];
  } else {
  float px=1.0/uPXPD, py=1.0/uPXPDY;
  /* 域扭曲一次共用：色调/材质查找与晕渲高程同一形变（涂改方块的直角沟壑随之弯成有机走向）。
     等高线/光标读数仍走未扭曲制图面 es——「晕渲是画、等高线是尺」，画可以形变，尺不动。
     邻点采样共用中心 warp（波长≈1.3 格≫1px，雅可比≈常数，法线误差可忽略）。 */
  vec2 wp=warpOf(rel);
  vec2 llw=ll+wp;
  gWarp=wp;   // 此后的采样全属扭曲族
  ws=wsAt(llw);   // 水陆判据、深浅色与近岸带的基准（内陆湖不在海平面）；与晕渲高程同取扭曲后坐标
  Mat mt=matAt(rel+wp+warp2Of(rel));   // 色调/材质权重中心取一次，五点采样共用（边界差 1px 可忽略）
  /* 宏观场坡先行（±1 格、无噪声）：①光照里再计一份基础坡，压低噪声皱纹话语权；
     ②陡处按坡度补糙度/棱脊——手雕高山常落在平原类型上，材质只认类型＝草地质感的光滑圆包 */
  vec2 mgv=vec2(cellAt(llw+vec2(-uGridBB.z,0.0)).x-cellAt(llw+vec2(uGridBB.z,0.0)).x,
                cellAt(llw+vec2(0.0,uGridBB.z)).x-cellAt(llw+vec2(0.0,-uGridBB.z)).x);
  float smac=length(mgv)/(2.0*uGridBB.z);   // |∇e| 每度
  float roughEff=max(mt.rough, min(float(${FX.slopeRoughMax}), smac*float(${FX.slopeRough})));
  vec4 twEff=vec4(mt.tw.xy, max(mt.tw.z, min(1.0, smac*float(${FX.slopeRidge}))), mt.tw.w);
  // 屏幕锚定纹理的幅度按 1/像素密度折算（明暗对比恒定不随缩放）；陡坡增纹已删（见 FX.texW 注）
  float texW=float(${FX.texW})/uPXPD;
  // 纹理疏密：世界锚定两八度低频调制（见 FX.texPatchF 头注）——五点采样共用此 texW，故不添假坡
  float pf=float(${FX.texPatchF})/uGridBB.z;
  float pn=0.65*vnoise2(rel*pf+vec2(19.3,5.7))+0.35*vnoise2(rel*pf*2.7+vec2(63.1,28.9));
  texW*=mix(float(${FX.texPatchLo}), float(${FX.texPatchHi}), smoothstep(0.32,0.68,pn));
  // 装饰噪声门（decoGate 同式；land 平滑过渡防岸线阶跃；fine 纯 uniform=一致控制流,粗格恒 1）
  float fine=max(uFStep<uGridBB.z*0.999?1.0:0.0, uEroded);   // 1× 细分的侵蚀场（60 km 缺省战场）同样过门
  float dk0=max(smoothstep(float(${FX.decoSlopeLo}),float(${FX.decoSlopeHi}),smac),
                smoothstep(float(${FX.decoRoughLo}),float(${FX.decoRoughHi}),mt.rough)*(1.0-uEroded));
  float decoK=1.0+(dk0-1.0)*smoothstep(ws-0.02,ws+0.02,cd.x)*fine;
  e=eAt(llw, roughEff, decoK);
  float eL=eAt(llw+vec2(-px,0.0),roughEff,decoK)+texAt(rel+vec2(-px,0.0),twEff)*texW;
  float eR=eAt(llw+vec2( px,0.0),roughEff,decoK)+texAt(rel+vec2( px,0.0),twEff)*texW;
  float eU=eAt(llw+vec2(0.0, py),roughEff,decoK)+texAt(rel+vec2(0.0, py),twEff)*texW;
  float eD=eAt(llw+vec2(0.0,-py),roughEff,decoK)+texAt(rel+vec2(0.0,-py),twEff)*texW;
  float nrm=4.5*(uPXPD/14.0)*uGain;
  vec3 nv=vec3((eL-eR)*nrm,(eU-eD)*nrm,1.0);
  /* 0.3214=nrm 对基础坡度的响应系数之半（2·nrm/uPXPD ÷2），两套法线同量纲可直接相加 */
  float mnk=0.3214/uGridBB.z*float(${FX.macroW})*uGain;
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
  float slc=min(sl,float(${FX.slopeKnee}))+sx2*float(${FX.slopeSoft})/(float(${FX.slopeSoft})+sx2);   // 膝内恒等：原式 knee+… 把任何微坡都拉到膝点长度＝平原褶皱的元凶
  float dn=dot(normalize(vec3(sv*(sl>1e-6? slc/sl : 1.0),1.0)), uLight);
  float lt=smoothstep(float(${FX.shadeKnee}),1.0,dn);
  lt*=1.0-occAt(llw)*float(${FX.shadowK});   // 烘焙投影阴影：背光谷底连同暖冷响应一起压暗（粗格全零）
  float sh=mix(float(${FX.shadeLo}),float(${FX.shadeHi}),lt);
  vec3 shT=mix(vec3(${FX.cool.join(",")}),vec3(${FX.warm.join(",")}),lt);
  float cav=clamp((es-cd.x)/uFStep*uGain*float(${2 * NRM0 * (1 + FX.macroW)})*float(${FX.cavAmp}), -0.10, 0.16);   // 帐篷差按真实坡度并随夸张走：谷暗脊明（廉价 AO）
  col=elevRamp(e,ws);   // 赋外层 col（此处若写 vec3 col 即遮蔽＝观感底图整幅黑）
  if(e>=ws-0.02){
    if(mt.tintW>0.0) col=mix(col, mt.tint, 0.45*mt.tintW);   // 软过渡；tintW=1 时与旧 55/45 直拼逐位同值
    // 生态辨识度：荒漠暖沙定调；沼泽湿绿+近景水洼/湿泥（键=材质权重 tw.y/tw.w，详见 material.ts）
    col=mix(col, vec3(${FX.sandC.join(",")}), mt.tw.y*float(${FX.sandMix}));
    if(mt.tw.w>0.003){
      col=mix(col, vec3(${FX.marshC.join(",")}), mt.tw.w*float(${FX.marshMix}));
      float pg=smoothstep(float(${FX.poolLo}),float(${FX.poolHi}),uPXPD*uGridBB.z)*mt.tw.w*float(uPaper);   // px/格；只在战术图——战略格上「2.5 格的塘」是十几公里的湖
      if(pg>0.003){
        float pf=float(${FX.poolF})/uGridBB.z;
        float pn=0.65*vnoise2(rel*pf+vec2(7.3,3.9))+0.35*vnoise2(rel*pf*2.7+vec2(51.3,17.9));   // 两八度：单八度值噪声的塘是轴对齐方块
        float pw=smoothstep(0.58,0.68,pn);
        col=mix(col, vec3(${FX.mudC.join(",")}), smoothstep(0.40,0.58,pn)*(1.0-pw)*pg*float(${FX.mudMix}));
        col=mix(col, vec3(${FX.poolC.join(",")}), pw*pg*float(${FX.poolMix}));
      }
    }
    vec3 LA=lodF(float(${FX.albPx}));   // 反照率抖动：屏幕锚定低频，打破平色（整幅视角下门控为零）
    float av=mix(vnoise2(rel*LA.x+vec2(19.9,7.1)), vnoise2(rel*LA.y+vec2(2.3,27.9)), LA.z)-0.5;
    col*=1.0+av*mt.albVar*float(${FX.albAmp})*gate(LA.x);
    float slp=length(nv.xy);    // 缩放无关坡度：陡处露岩（微八度让坡度随放大长细节，岩斑自然斑驳）
    float rk=smoothstep(float(${FX.rockSlopeLo}),float(${FX.rockSlopeHi}),slp)*mt.rock;
    vec3 rockC=mix(vec3(0.36,0.33,0.30), vec3(0.62,0.60,0.57), clamp(e*1.1,0.0,1.0));
    col=mix(col, rockC, rk*float(${FX.rockMix}));
    // 雪按米落（material.snowSpec 同式：气候档基准 + 球面图随纬度；陡坡挂不住雪打六折）——色阶顶带只剩灰岩，白色归雪
    float snE=max(0.0, uSnowE+uSnowLat*(snowLatM(abs(ll.y))-uSnowRef)*uSnowUnit);
    float sn=smoothstep(snE,snE+float(${FX.snowBand}),e)*(1.0-0.6*smoothstep(float(${FX.snowSlopeLo}),float(${FX.snowSlopeHi}),slp));
    col=mix(col, vec3(0.93,0.94,0.965), sn);
    col=mix(col, vec3(${FX.airC.join(",")}), smoothstep(float(${FX.airLo}),float(${FX.airHi}),e)*float(${FX.airMix}));   // 空气透视
    col*=sh*shT*(1.0-cav);
  } else {
    // 近岸浅水带：随缩放渐隐（px/° 区间见 FX.shoreLo/Hi）——整幅视角下固定高程区间摊成贴纸大光环
    float shore=smoothstep(ws-0.10,ws-0.02,e)*smoothstep(float(${FX.shoreLo}),float(${FX.shoreHi}),uPXPD*uGridBB.z);
    col=mix(col, vec3(0.55,0.72,0.75), shore*float(${FX.shoreMix}));
    vec3 LW=lodF(float(${FX.wavePx}));  // 静态波纹（横向拉伸；无动画，尊重空闲降频）
    float wv=mix(ridged(vnoise2(vec2(rel.x*0.35,rel.y)*LW.x+vec2(3.1,9.7))),
                 ridged(vnoise2(vec2(rel.x*0.35,rel.y)*LW.y+vec2(21.3,1.1))), LW.z);
    col*=1.0+(wv-0.5)*float(${FX.waveAmp})*gate(LW.x);
  }
  }
  // 岸线（只给观感底图；推演底图的水陆界就是格边，按高程描线会与格边错位）。fwidth 在分支外取＝一致控制流
  float aa=fwidth(e)+1e-6;
  float coast=1.0-smoothstep(0.0, aa*1.4, abs(e-ws+0.02));
  col=mix(col, vec3(38.0,66.0,86.0)/255.0, coast*0.55*(1.0-float(uMode)));
  // 网格内缩一格的图幅裁边：世界 bbox 外=深海，制图面在边缘塌向海——贴边假线截掉（neatline 惯例）
  if(uContour==1 && er>=ws-0.02 && rel.x>uGridBB.z && rel.y>uGridBB.z && rel.x<uGridSpan.x-uGridBB.z && rel.y<uGridSpan.y-uGridBB.z){
    // 等高线画在规则场制图面 er（晕渲是画，等高线是尺）。两套线系各按 contourK 着墨，按 uCFade 交叉淡入。
    // 间曲线的浮现门看 ±10 px 差分的**粗坡**，不看逐像素梯度：侵蚀微起伏让局部梯度远大于宏观坡，按它算线距会低估几十倍、平地上永远开不了门；
    // 虚线相位锚网格原点的像素坐标（平移不爬动），对 ±切向对称（CPU 的 y 轴反向也同相）
    // 线落在等距的**整数倍**上（高程自海面 0 起算，与光标读数同一把尺）：早先 +0.02 是为让最低那条压住水陆界，
    // 代价是每条线都偏 0.02×elevUnitM（战术图 40 m）＝注记读不出圆整数。0 米线仍贴着岸走（陆地一格内就跃过 0）。
    float eh=er;
    gWarp=vec2(0.0);   // 粗坡采样属制图面族（本块之后再无扭曲族采样）
    float kx=10.0/uPXPD*uDPR, ky=10.0/uPXPDY*uDPR;
    vec2 gc=vec2(ruleSmooth(ll+vec2(kx,0.0))-ruleSmooth(ll-vec2(kx,0.0)), ruleSmooth(ll+vec2(0.0,ky))-ruleSmooth(ll-vec2(0.0,ky)))/20.0;   // ±10 CSS px 的差分÷20＝每 CSS px 的坡；再除 DPR 就成了每物理像素，高分屏上间曲线提前浮现
    float gsl=abs(gc.x)+abs(gc.y)+1e-7;
    vec2 tg=normalize(vec2(-gd.y,gd.x)+vec2(1e-9,0.0));
    float sdp=dot(tg,(ll-uGridBB.xy)*vec2(uPXPD,uPXPDY))/uDPR;
    float k=inkK(eh,ad,gsl,sdp,0.0), kh=inkK(eh,ad,gsl,sdp,float(${FX.haloPx}));
    // 亮晕只画核外环（kh−k），按底色亮度渐隐：暗坡上棕线与底同亮，靠环保证可见（判据见 material.FX.halo*）
    float hg=1.0-smoothstep(float(${FX.haloLo}),float(${FX.haloHi}),dot(col,vec3(0.299,0.587,0.114)));
    col=mix(col, vec3(${FX.haloC.join(",")}), max(0.0,kh-k)*hg);
    col=mix(col, vec3(90.0,70.0,40.0)/255.0, k);
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
  /* 高程场+遮蔽纹理（侵蚀细分后维度 ≠ 粗格）：画面场与规则场各一份——TEXTURE1 绑本帧的画面（观感底图＝画面场，
     精修档在此；推演底图＝规则场），TEXTURE2 恒绑规则场供等高线取样（与光标读数同源）。两场同一对象时只建一份。 */
  interface FieldTex { tex: WebGLTexture | null; cols: number; rows: number; step: number; eroded: number }
  let fDisp: FieldTex | null = null, fRule: FieldTex | null = null;
  let g: Grid | null = null;
  let lastField: ElevField | undefined, lastRule: ElevField | undefined;   // 存最近两场：上下文丢失恢复时重传
  let lastWS: Float32Array = new Float32Array(0);
  const U = (n: string) => gl.getUniformLocation(pr!, n);

  /* 建程序 + 设常量 uniform（创建时 + webglcontextrestored 后重跑）。 */
  function initProgram(): boolean {
    pr = compileProgram(gl);
    if (!pr) return false;
    gl.useProgram(pr);
    gl.uniform1i(U("uGrid"), 0);
    gl.uniform1i(U("uField"), 1);
    gl.uniform1i(U("uRule"), 2);
    const light = [-0.6, -0.6, 0.9], ll = Math.hypot(...light);
    gl.uniform3f(U("uLight"), light[0] / ll, light[1] / ll, light[2] / ll);
    const comps = allComposites();   // 30 个复合，顺序与 compositeIndex 对齐（旧 8 类落在各自复合上、色/tint 逐位复现）
    gl.uniform3fv(U("uTColor[0]"), comps.flatMap(cc => hexV(terrainProps(cc).color)));
    gl.uniform3fv(U("uTint[0]"), comps.flatMap(cc => { const t = terrainProps(cc).tint; return t ? [t[0], t[1], t[2]] : [-1, -1, -1]; }));
    const mats = materialTable();    // 渲染材质（同序；render/material.ts 真源，CPU 兜底同表）
    gl.uniform4fv(U("uMatA[0]"), mats.flatMap(m => [m.canopy, m.dune, m.ridge, m.marsh]));
    gl.uniform4fv(U("uMatB[0]"), mats.flatMap(m => [m.rough, m.albVar, m.rock, 0]));
    return true;
  }
  /* 纹理边长上限（2026-08-31 审查）：精修档 axisMax=16 只按总格数与单轴倍率封顶，不看设备能力——
     细长战场（如手编/导入的 2048×1）算出的场是 32768×16，是常见 MAX_TEXTURE_SIZE(16384) 的两倍。
     超限的 texImage2D 只置 GL 错误码、不抛异常，采样恒零＝整幅地形静默变白。超了就退回粗格场：
     少的是侵蚀细节，不是整张图。 */
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  let texWarned = false;
  const fieldFits = (f?: ElevField): boolean => {
    if (!f || (f.cols <= maxTex && f.rows <= maxTex)) return true;
    if (!texWarned) { texWarned = true; console.warn(`细分场 ${f.cols}×${f.rows} 超出本机纹理上限 ${maxTex}，退回粗格高程（地形仍可用，少的是侵蚀细节）`); }
    return false;
  };
  /* 高程场纹理：R=高程 G=遮蔽（未传场＝按类型合成粗格，旧行为；遮蔽全零）。在 1 号单元上建、建完还原到 0 号 */
  function fieldTex(grid: Grid, field?: ElevField): FieldTex {
    const fc = field ? field.cols : grid.cols, fr = field ? field.rows : grid.rows;
    const fd = new Float32Array(fc * fr * 2);
    if (field) {
      for (let k = 0; k < fc * fr; k++) { fd[k * 2] = field.data[k]; fd[k * 2 + 1] = field.shadow ? field.shadow[k] : 0; }
    } else {
      for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) fd[(r * grid.cols + c) * 2] = terrainProps(grid.cells[r][c]).elev;
    }
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, fc, fr, 0, gl.RG, gl.FLOAT, fd);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);   // 常规活动纹理还原到 0 号（类型纹理绑定预期）
    return { tex: t, cols: fc, rows: fr, step: field ? field.step : grid.step, eroded: field && field.shadow ? 1 : 0 };
  }
  const dropFieldTex = (): void => {
    if (fDisp) gl.deleteTexture(fDisp.tex);
    if (fRule && fRule !== fDisp) gl.deleteTexture(fRule.tex);
    fDisp = fRule = null;
  };
  /** 把场纹理绑到纹理单元并同步它的几何 uniform（1＝画面场 uFDim/uFStep，2＝规则场 uRDim/uRStep） */
  function bindField(unit: number, f: FieldTex, dim: string, step: string): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, f.tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2i(U(dim), f.cols, f.rows);
    gl.uniform1f(U(step), f.step);
  }
  function doUpload(grid: Grid, wsurf: Float32Array, fieldIn: ElevField | undefined, ruleIn: ElevField | undefined) {
    if (!pr) return;
    const field = fieldFits(fieldIn) ? fieldIn : undefined;
    const rule = ruleIn === fieldIn ? field : fieldFits(ruleIn) ? ruleIn : undefined;
    if (tex) gl.deleteTexture(tex);
    dropFieldTex();
    /* 类型粗格纹理：R=水面高程（core/elev.waterSurface）G=复合索引 lf*5+eco */
    const data = new Float32Array(grid.cols * grid.rows * 2);
    for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
      const k = r * grid.cols + c, i = k * 2;
      data[i] = wsurf[k];
      data[i + 1] = compositeIndex(grid.cells[r][c]);
    }
    tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, grid.cols, grid.rows, 0, gl.RG, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    fDisp = fieldTex(grid, field);
    fRule = rule === field ? fDisp : fieldTex(grid, rule);
    gl.uniform4f(U("uGridBB"), grid.bb.lonMin, grid.bb.latMin, grid.step, (grid.bb.lonMin + grid.bb.lonMax) / 2);
    gl.uniform2i(U("uGridDim"), grid.cols, grid.rows);
    gl.uniform2f(U("uGridSpan"), grid.bb.lonMax - grid.bb.lonMin, grid.bb.latMax - grid.bb.latMin);
  }

  if (!initProgram()) return null;   // 探针过后此处基本必过；稳妥兜底

  /* 上下文丢失/恢复（GPU 进程崩溃、驱动重置、后台标签回收）：
     preventDefault 才有 restored；恢复后 program/纹理全失效，重建并重传网格——
     下一帧 rAF 自动出图，外壳零改动。缺此则地形永久空白（审计）。 */
  /* GPU 名只在建上下文与上下文恢复时各查一次：UNMASKED_RENDERER 的 getParameter 是同步等 GPU 进程的往返，
     曾被 hud 每个绘帧调用＝平移时主线程每帧空等（DPR 2 实测 35 ms/帧） */
  const queryName = (): string => {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return (ext && (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string)) || (gl.getParameter(gl.RENDERER) as string) || "WebGL2";
  };
  let name = queryName();
  const onLost = (e: Event) => { e.preventDefault(); };
  const onRestored = () => { tex = null; fDisp = fRule = null; name = queryName(); if (initProgram() && g) doUpload(g, lastWS, lastField, lastRule); };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    canvas, kind: "webgl2",
    uploadGrid(grid: Grid, wsurf: Float32Array, field?: ElevField, rule?: ElevField) {
      g = grid; lastWS = wsurf; lastField = field; lastRule = rule || field;
      doUpload(grid, wsurf, field, lastRule);
    },
    render(viewBB: BBox, opts: TerrainRenderOpts = {}) {
      const f = opts.flat ? fRule : fDisp;
      if (!g || !pr || !f || !fRule) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      bindField(1, f, "uFDim", "uFStep");
      gl.uniform1f(U("uEroded"), f.eroded);
      bindField(2, fRule, "uRDim", "uRStep");
      gl.uniform4f(U("uViewBB"), viewBB.lonMin, viewBB.latMin, viewBB.lonMax, viewBB.latMax);
      gl.uniform2f(U("uRes"), canvas.width, canvas.height);
      gl.uniform1f(U("uPXPD"), canvas.width / (viewBB.lonMax - viewBB.lonMin));
      gl.uniform1f(U("uPXPDY"), canvas.height / (viewBB.latMax - viewBB.latMin));
      gl.uniform1i(U("uMode"), opts.flat ? 1 : 0);
      gl.uniform1i(U("uContour"), opts.contour ? 1 : 0);
      gl.uniform1f(U("uCA"), opts.cA || 0.12);
      gl.uniform1f(U("uCB"), opts.cB || opts.cA || 0.12);
      gl.uniform1f(U("uCFade"), opts.cFade || 0);
      gl.uniform1f(U("uDPR"), opts.dpr ?? 1);
      gl.uniform1i(U("uWrap"), opts.wrap ? 1 : 0);
      gl.uniform1i(U("uPaper"), opts.paper ? 1 : 0);
      const S = opts.snow;
      gl.uniform1f(U("uSnowE"), S ? S.base : 1e9);
      gl.uniform1f(U("uSnowLat"), S && S.lat ? 1 : 0);
      gl.uniform1f(U("uSnowRef"), S ? S.refM : 0);
      gl.uniform1f(U("uSnowUnit"), S ? 1 / S.unitM : 0);
      gl.uniform1f(U("uGain"), opts.gain ?? 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    maxDim() {
      const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
      return Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, vp[0], vp[1]);
    },
    rendererName() { return name; },
    dispose() {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (tex) gl.deleteTexture(tex);
      dropFieldTex();
      if (pr) gl.deleteProgram(pr);
    }
  };
}
