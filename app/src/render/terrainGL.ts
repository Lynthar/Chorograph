/* WebGL2 地形渲染器。
   职责边界：分类网格（游戏真源）由 core/grid 在 CPU 计算、作为 RG32F 纹理上传（R=示意高程 G=类型索引）；
   本模块只做像素观感——高程双线性 + 细节噪声 + 晕渲 + 色阶 + 生态色调 + 海岸线 + 等高线。
   等高线例外地画在**规则场（工作档）的无噪声制图面**上（画面场可为精修档，线不跟它＝与读数同一个数）：
   首曲线+计曲线（每第 5 条），等距由 core/elev.contourStepFor 随缩放与地势在 1-2-5 阶梯上取档（uCStep，任一时刻一套线系）；
   像素量按 uDPR 锚 CSS 像素。
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
import { terrainProps, compositeIndex, allComposites, COMPOSITE_COUNT, WATER_EPS } from "../core/constants.ts";
import { climRampGLSL, contourGLSL, glslF as glF, materialTable, rampGLSL, shadeGLSL, shoreGLSL, snowLatGLSL, textureGLSL, waterGLSL, CLIM_STOPS, CONTOUR, FINE_STEP_K, FULL_WRAP_DEG, MICRO_F0, NOISE, NRM_K, NRM_PX, FX, PAPER_RGB, SHADE_LIGHT, WATER } from "./material.ts";
import { riverGLSL, riverTexels, RIV_TEX_W, type RiverSet } from "./rivers.ts";
import { bandField } from "./beach.ts";
import { zoneGLSL, zoneLookTexels, ZLOOK_W, ZONE_N, type ZoneWeights } from "./zones.ts";
import type { Grid } from "../core/grid.ts";
import { shrinkField, type ElevField, type RuleField } from "../core/elev.ts";
import type { BBox } from "../core/types.ts";
import { tileResidency, tilesInView, tileSlotsFor, tileWeight, TILE_SLOTS, type TileLayer } from "../core/tiles.ts";

const VS = `#version 300 es
void main(){ vec2 p=vec2(float(gl_VertexID<<1&2), float(gl_VertexID&2)); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;

const WG = waterGLSL();
/* material 的表进着色器：glF＝浮点字面量（float32 与手写同值） */
const N = NOISE, C = CONTOUR, EPS = glF(WATER_EPS);
const FS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uGrid;          // RG32F: R=水面高程(海 0/内陆湖岸线高) G=复合索引(地貌×生态数+生态)——均粗格最近取
uniform sampler2D uField;         // R32F 高程场（粗格=coarseField；细分=erode 产出）
uniform vec4 uGridBB;             // lonMin,latMin,step,wrap中心经度
uniform ivec2 uGridDim;           // cols,rows（类型粗格）
uniform ivec2 uFDim;              // 高程场维度（侵蚀细分后 ≠ uGridDim）
uniform float uFStep;             // 度/场格
uniform sampler2D uRule;          // R32F 规则场（工作档）：等高线只从它取样＝与光标读数同源；画面场为精修档时线不跟画面
uniform ivec2 uRDim;              // 规则场维度
uniform float uRStep;             // 度/规则场格
uniform vec2 uGridSpan;           // 网格真实跨度(lonMax-lonMin,latMax-latMin)：出界判定用，对齐 CPU/旧版 bbox
uniform vec4 uViewBB;             // lonMin,latMin,lonMax,latMax
uniform vec2 uRes;                // x=视口宽 y=缓冲高（像素行自缓冲顶起算；可见区贴缓冲顶，画布可大于可见区）
uniform float uPXPD;              // 横向像素/度（经度有 cos(lat0) 校正，与纵向不同）
uniform float uPXPDY;             // 纵向像素/度（对齐旧 drawTile 经 project 的各向异性贴图）
uniform float uCStep;             // 等高距（抽象单位；contourStepFor：1-2-5 阶梯上的一档，任一时刻只有一套线系）
uniform float uDPR;               // 设备像素比：等高线线宽、挤线门、间曲线门与虚线节距按 CSS 像素锚定（1＝逐位旧行为）
uniform vec3 uLight;
uniform int uMode;                // 0=观感底图 1=推演底图（逐格平色）
uniform int uContour;
uniform int uWrap;                // 1=球面经度环绕（把片元经度折回世界本初域），0=平面
uniform int uBeach;               // 1=画滩带：水边的浅色带（material.beachK，只战术图）
uniform sampler2D uBand;          // RG32F 滩带场（render/beach.bandField）：R=还在带内多少格 G=那片水的水面；不画滩带时是 1×1 占位
uniform int uPaper;               // 1=纸模式（material.paperOf）：画布上图幅外铺纸色、开小水塘
uniform float uSnowE;             // 雪线抽象高程（图幅中心；material.snowSpec.base；不落雪=1e9）
uniform float uSnowLat, uSnowRef, uSnowUnit;   // 随纬度：开关 0/1（球面图且设了气候档）、参考曲线在中心纬度的米值、1/elevUnitM
uniform int uClim, uClimN;        // 气候观感（material.climLook）：开关 0/1、色阶段数（0＝沿用 elevLand）
uniform vec4 uClimRamp[${CLIM_STOPS}];
uniform float uTreeE, uTreeBand;  // 林线抽象高程与淡出带宽
uniform vec3 uMeadow;             // 林线以上森林染色换成的高山草甸色
uniform int uZone;                // 1＝气候分区在场（render/zones）：各档结果按权重混
uniform sampler2D uZW0, uZW1;     // 各档权重 RGBA8（档 0..3 / 4..6）
uniform sampler2D uZLook;         // 每档观感 RGBA32F（zones.zoneLookTexels）
uniform vec4 uZoneBB;             // 权重纹理覆盖范围：lonMin,latMin,经跨,纬跨
uniform float uGain;              // 晕渲法线增益（material.shadeGain：夸张 E∈[4,8] 倍真实坡度）
uniform float uSlopeK;            // 宏观坡 → 坡角正切（material.slopeKOf；0＝沼泽不按坡门控）
uniform float uEroded;            // 1=场经侵蚀（ElevField.eroded）：装饰噪声按坡门控、宏观 fbm4 降到四分之一——真形自己带起伏
uniform highp sampler2DArray uTAtlas;   // 分块精修的块（R32F，一块一层；core/tiles）
uniform highp isampler2D uTPage;  // 块号 → 层号（R32I，-1＝不在显存）
uniform float uTW;                // 块的缩放权重（core/tiles.tileWeight；0＝不用块）
uniform float uTStep;             // 度/块格
uniform ivec2 uTDim;              // 全图块格维度
uniform int uTK;                  // 一块的块格边长
uniform int uRiv;                 // 1＝有河段宽过本帧门槛（render/rivers：河当水体画）
uniform vec4 uRivA;               // 河段分桶原点经纬、桶边长（度）、判水面门槛（度）
uniform ivec2 uRivN;              // 桶数
uniform highp sampler2D uRSeg;    // 河段 RGBA32F（rivers.riverTexels）
uniform highp isampler2D uRIdx;   // 各桶（起点, 段数）+ 桶内段号 R32I
uniform vec3 uTColor[${COMPOSITE_COUNT}];   // 各复合平色＝terrainProps.color（推演底图用；G 通道即复合索引）
uniform vec3 uTint[${COMPOSITE_COUNT}];     // 各复合生态色调（无=vec3(-1)）
uniform vec4 uMatA[${COMPOSITE_COUNT}];     // 材质纹理权重(canopy,dune,ridge,marsh)——render/material.ts 真源
uniform vec4 uMatB[${COMPOSITE_COUNT}];     // (微起伏rough, 反照率抖动albVar, 岩化rock, 水域1/陆0)
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
vec2 grad2(ivec2 p){ float a=hashI(p)*${glF(N.tau)}; return vec2(cos(a),sin(a)); }
float gnoise2(vec2 x){ ivec2 i=ivec2(floor(x)); vec2 f=fract(x); vec2 u=f*f*(3.0-2.0*f);
  float a=dot(grad2(i),f), b=dot(grad2(i+ivec2(1,0)),f-vec2(1.0,0.0)),
        c=dot(grad2(i+ivec2(0,1)),f-vec2(0.0,1.0)), d=dot(grad2(i+ivec2(1,1)),f-vec2(1.0,1.0));
  return a+(b-a)*u.x+(c-a)*u.y+(a-b-c+d)*u.x*u.y; }

const float MF0=float(${MICRO_F0});   // 微八度基频（接续 fbm4 频谱下一档；material.ts 单一真源）
/* 出界判据看**未扭曲**位置：gWarp＝当前采样族的域扭曲量（main 里扭曲族置 wp、制图面族置 0）。
   按扭曲后的点判，贴边像素被推出图幅就掉进深海、图幅外的被推进来就长出陆地＝图廓两侧各啃一圈锯齿。 */
vec2 gWarp=vec2(0.0);
bool outside(vec2 rel){ vec2 u=rel-gWarp; return u.x<0.0||u.y<0.0||u.x>uGridSpan.x||u.y>uGridSpan.y; }
/* 八度门（同 material.octaveGate：整幅视角下恒 0）、两个脊形变换、水洼 / 反照率 / 波纹的噪声、屏幕频率、域扭曲（双频 < 半格；长波与碎化只喂色调 / 材质查找、有意超半格）、
   微八度、材质纹理与第一趟的几条规则：material.textureGLSL 生成，
   TS 同名函数写在一起。texAt 的产出不喂 fwidth，divergent 分支无害（e / es 的一致控制流纪律见 eAt / elevSmooth） */
${textureGLSL()}
/* 域扭曲后的四角双线性材质/色调（tint 缺项按权归一；出格靠 clamp 取边缘格，与 cellAt 的钳制同规） */
struct Mat { vec3 tint; float tintW; vec4 tw; float rough; float albVar; float rock; };
Mat matAt(vec2 rw){   // rw=已扭曲的局部坐标（调用方算一次 warp，与晕渲共用）
  vec2 f=rw/uGridBB.z-0.5;
  ivec2 c0=clamp(ivec2(floor(f)), ivec2(0), uGridDim-1);
  ivec2 c1=min(c0+1, uGridDim-1);
  vec2 t=clamp(f-vec2(c0), 0.0, 1.0);
  vec4 w=vec4((1.0-t.x)*(1.0-t.y), t.x*(1.0-t.y), (1.0-t.x)*t.y, t.x*t.y);
  ivec4 tc;
  for(int i=0;i<4;i++) tc[i]=int(texelFetch(uGrid, ivec2((i==1||i==3)?c1.x:c0.x, (i>=2)?c1.y:c0.y), 0).g+0.5);
  // 同类合并后按占比平方加权（material.blendSharp 同式）：色界走双线性过半的那条线，过渡仍约半格宽
  vec4 ws4; float wsum=0.0;
  for(int i=0;i<4;i++){ float W=0.0; for(int j=0;j<4;j++) if(tc[j]==tc[i]) W+=w[j]; ws4[i]=w[i]*W*W; wsum+=ws4[i]; }
  w=ws4/wsum;
  Mat m; m.tint=vec3(0.0); m.tintW=0.0; m.tw=vec4(0.0); m.rough=0.0; m.albVar=0.0; m.rock=0.0;
  for(int i=0;i<4;i++){
    int ti=tc[i];
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

/* 场纹理双线性（格心对齐、边缘 clamp；出界判定由调用方做）：R=高程 */
float fieldBil(sampler2D fld, ivec2 dim, float st, vec2 rel){
  vec2 f=rel/st-0.5;
  ivec2 c0=clamp(ivec2(floor(f)), ivec2(0), dim-1);
  ivec2 c1=min(c0+1, dim-1);
  vec2 t=clamp(f-vec2(c0), 0.0, 1.0);
  float s00=texelFetch(fld,ivec2(c0.x,c0.y),0).r, s10=texelFetch(fld,ivec2(c1.x,c0.y),0).r;
  float s01=texelFetch(fld,ivec2(c0.x,c1.y),0).r, s11=texelFetch(fld,ivec2(c1.x,c1.y),0).r;
  float top=s00+(s10-s00)*t.x, bot=s01+(s11-s01)*t.x;
  return top+(bot-top)*t.y;
}
/* 块层双线性（core/tiles.tileElevAt 同式）：四个取样格逐个查页表，有一个不在显存＝false（调用方退回画面场） */
float tileTexel(ivec2 g, inout bool ok){
  ivec2 t=g/uTK; int s=texelFetch(uTPage,t,0).r;
  if(s<0){ ok=false; return 0.0; }
  return texelFetch(uTAtlas,ivec3(g-t*uTK,s),0).r;
}
bool tileBil(vec2 rel, out float e){
  vec2 f=rel/uTStep-0.5;
  ivec2 c0=clamp(ivec2(floor(f)), ivec2(0), uTDim-1);
  ivec2 c1=min(c0+1, uTDim-1);
  vec2 t=clamp(f-vec2(c0), 0.0, 1.0);
  bool ok=true;
  float s00=tileTexel(c0,ok), s10=tileTexel(ivec2(c1.x,c0.y),ok), s01=tileTexel(ivec2(c0.x,c1.y),ok), s11=tileTexel(c1,ok);
  float top=s00+(s10-s00)*t.x, bot=s01+(s11-s01)*t.x;
  e=top+(bot-top)*t.y;
  return ok;
}
vec2 cellAt(vec2 ll){ // (双线性画面场高程, 最近格类型索引)——高程走细分场纹理、类型仍粗格最近取
  // 出界 clamp 延伸＝CPU elevBilinear 同语义：图廓外由叠加层铺纸，贴边法线不许落进深海画出一圈崖影
  vec2 rel=ll-uGridBB.xy;
  ivec2 n=clamp(ivec2(floor(rel/uGridBB.z)), ivec2(0), uGridDim-1);
  float e=fieldBil(uField,uFDim,uFStep,rel), te;
  if(uTW>0.0 && tileBil(rel,te)) e=mix(e,te,uTW);   // 块按缩放权重混入（块只进画面，规则场不走这里）
  return vec2(e, texelFetch(uGrid,n,0).g);
}
float ruleAt(vec2 ll){ // 规则场（工作档）双线性高程：等高线的唯一采样源；出界语义同 cellAt
  vec2 rel=ll-uGridBB.xy;
  return fieldBil(uRule,uRDim,uRStep,rel);
}
/* 高程细节场：双线性数据面 + 宏观 fbm4（旧式逐位）+ 微八度；dk=装饰噪声门（判据见 material.decoGate） */
float eAt(vec2 ll, float mrough, float dk){
  float e=cellAt(ll).x;
  if(dk<=0.0) return e;   // 门关（平地或块权重满）＝噪声两项恒零，免算
  float rough=fbmRough(e,uEroded);
  e+=(fbm4(ll*${glF(FX.fbmF)})-0.5)*rough*2.0*dk;
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
   计曲线带宽 0.9–1.65 只比首曲线 0.8–1.5 略宽，主要靠墨 0.70 与首曲线区分（2026-09-21 用户拍板）；bo=带宽外扩像素（亮晕用同一带外扩）；oddK=倍数奇偶（只淡入奇数倍新线） */
/* 等高线着墨：首曲线、计曲线、间曲线与助曲线（material.contourK 同式，由 contourGLSL 生成） */
${contourGLSL()}
/* 水面高程（粗格最近取，同类型索引）：海=0，内陆湖=岸线高度，陆格取相邻水体水面
   （core/elev.waterSurface 已晕开一格＝湖岸线随细分场摆动，不被粗格边切成方块）。
   图幅外恒 0（那里铺纸，只剩贴边采样会越界）。 */
float wsAt(vec2 ll){
  vec2 rel=ll-uGridBB.xy;
  if(outside(rel)) return 0.0;
  ivec2 n=clamp(ivec2(floor(rel/uGridBB.z)), ivec2(0), uGridDim-1);
  return texelFetch(uGrid,n,0).r;
}
${rampGLSL()}
${snowLatGLSL()}
${climRampGLSL()}
${zoneGLSL()}
${riverGLSL()}
${shoreGLSL()}
${shadeGLSL()}
/* 滩带场的双线性（rw＝已扭曲的局部坐标；出格取边格，同 render/beach.bandAt）。战术图不环绕 */
vec2 bandAt(vec2 rw){
  vec2 f=rw/uGridBB.z-0.5;
  ivec2 c0=clamp(ivec2(floor(f)), ivec2(0), uGridDim-1), c1=min(c0+1, uGridDim-1);
  vec2 t=clamp(f-vec2(c0), 0.0, 1.0);
  vec2 lo=mix(texelFetch(uBand,c0,0).rg, texelFetch(uBand,ivec2(c1.x,c0.y),0).rg, t.x);
  vec2 hi=mix(texelFetch(uBand,ivec2(c0.x,c1.y),0).rg, texelFetch(uBand,c1,0).rg, t.x);
  return mix(lo,hi,t.y);
}
/* 岸值：四角类型格水陆标志的双线性，陆占比−0.5（rw＝已扭曲的局部坐标） */
float shoreAt(vec2 rw){
  vec2 f=rw/uGridBB.z-0.5;
  ivec2 i0=ivec2(floor(f)), c0=clamp(i0, ivec2(0), uGridDim-1), c1=min(c0+1, uGridDim-1);
  vec2 t=clamp(f-vec2(c0), 0.0, 1.0);
  if(uWrap==1 && uGridSpan.x>${glF(FULL_WRAP_DEG)}){ c0.x=(i0.x+uGridDim.x)%uGridDim.x; c1.x=(c0.x+1)%uGridDim.x; t.x=f.x-float(i0.x); }
  vec4 w=vec4((1.0-t.x)*(1.0-t.y), t.x*(1.0-t.y), (1.0-t.x)*t.y, t.x*t.y);
  float L=0.0;
  for(int i=0;i<4;i++){
    float g=texelFetch(uGrid, ivec2((i==1||i==3)?c1.x:c0.x, (i>=2)?c1.y:c0.y), 0).g;
    if(uMatB[int(g+0.5)].w<0.5) L+=w[i];
  }
  return L-0.5;
}
vec3 elevRamp(float e,float ws,float dl){
  if(e<ws-${EPS}){ float t=waterT(e,ws); return ${WG.ramp}; }
  if(uClimN>0) return climRamp(e,dl);   // 气候色阶（dl＝球面图纬度改正）
  return elevLand(e);   // 陆地分层设色＝material.rampColor 同源（CPU 同）
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
  float shs=0.5;   // 岸值（观感底图才取；推演底图恒 0.5＝不描岸线）
  float rsd=1e9;   // 到当水画的河面的有向距离（像素，负＝在河里；1e9＝附近没有）：只在观感底图取
  if(uMode==1){
    /* 推演底图：所在格的类型平色（uTColor＝terrainProps.color），不扭曲、不晕渲、不铺纹理——
       像素的颜色就是光标读数与寻路读到的那一格；等高线与纸色在下方照画 */
    ws=wsAt(ll); e=cd.x;
    // 图幅外＝深海（同 CPU 兜底的底色；水域格的浅蓝只给格子，图幅界才看得见）；纸模式由末尾纸色覆盖
    col=outside(rel) ? ${WG.deep} : uTColor[int(cd.y+0.5)];
  } else {
  float px=1.0/uPXPD, py=1.0/uPXPDY;
  /* 域扭曲一次共用：色调/材质查找与晕渲高程同一形变（涂改方块的直角沟壑随之弯成有机走向）。
     等高线/光标读数仍走未扭曲制图面 es——「晕渲是画、等高线是尺」，画可以形变，尺不动。
     邻点采样共用中心 warp（波长≈1.3 格≫1px，雅可比≈常数，法线误差可忽略）。 */
  vec2 wp=warpOf(rel);
  vec2 llw=ll+wp;
  gWarp=wp;   // 此后的采样全属扭曲族
  ws=wsAt(llw);   // 水陆判据、深浅色与近岸带的基准（内陆湖不在海平面）；与晕渲高程同取扭曲后坐标
  vec2 rws=rel+wp; shs=shoreAt(rws);   // 画面的水陆由岸值定；五个采样点各取各的，法线才是同一张面的差分
  Mat mt=matAt(rel+wp+warp2Of(rel));   // 色调/材质权重中心取一次，五点采样共用（边界差 1px 可忽略）
  float dLat=latShift(ll.y,uSnowLat,uSnowRef,uSnowUnit);   // 球面图气候带的纬度改正：雪线、林线、色阶同一个
  /* 宏观场坡先行（±1 格、无噪声）：①光照里再计一份基础坡，压低噪声皱纹话语权；
     ②陡处按坡度补糙度/棱脊——手雕高山常落在平原类型上，材质只认类型＝草地质感的光滑圆包 */
  vec2 mgv=vec2(cellAt(llw+vec2(-uGridBB.z,0.0)).x-cellAt(llw+vec2(uGridBB.z,0.0)).x,
                cellAt(llw+vec2(0.0,uGridBB.z)).x-cellAt(llw+vec2(0.0,-uGridBB.z)).x);
  float smac=length(mgv)/(2.0*uGridBB.z);   // |∇e| 每度
  mt.tw.w*=marshGate(smac,uSlopeK);   // 沼泽按坡淡出
  float roughEff=slopeRough(smac,mt.rough);
  vec4 twEff=vec4(mt.tw.xy, slopeRidge(smac,mt.tw.z), mt.tw.w);
  float ftc=uClim==1 ? treeFade(uTreeE,dLat,uTreeBand,cd.x) : 0.0;   // 林线以上森林淡出
  vec3 mead=uMeadow;
  if(uZone==1){ zoneW(ll); zoneTree(cd.x,dLat,ftc,mead); }   // 气候分区：各档林线按权重混
  float fk=meadowK(ftc,mt.tw.x);
  twEff.x*=1.0-ftc;
  // 屏幕锚定纹理的幅度按 1/像素密度折算（明暗对比恒定不随缩放）；陡坡增纹已删（见 FX.texW 注）
  float texW=float(${FX.texW})/uPXPD;
  // 纹理疏密：世界锚定两八度低频调制（见 FX.texPatchF 头注）——五点采样共用此 texW，故不添假坡
  texW*=texPatchK(patchN(rel));
  // 装饰噪声门（decoGate 同式；land 平滑过渡防岸线阶跃；fine 纯 uniform=一致控制流,粗格恒 1）
  float fine=max(uFStep<uGridBB.z*${glF(FINE_STEP_K)}?1.0:0.0, uEroded);   // 1× 细分的侵蚀场（60 km 缺省战场）同样过门
  float decoK=decoGate(smac, mt.rough*(1.0-uEroded), smoothstep(ws-${EPS},ws+${EPS},cd.x), fine);   // 侵蚀场上类型糙度不算数
  float tb; if(uTW>0.0 && tileBil(llw-uGridBB.xy,tb)) decoK*=1.0-uTW;   // 块里的起伏是真算的：装饰噪声随块退场，否则同一波段画两遍
  e=shoreFix(eAt(llw, roughEff, decoK), ws, shs);
  float eL=shoreFix(eAt(llw+vec2(-px,0.0),roughEff,decoK),ws,shoreAt(rws+vec2(-px,0.0)))+texAt(rel+vec2(-px,0.0),twEff)*texW;
  float eR=shoreFix(eAt(llw+vec2( px,0.0),roughEff,decoK),ws,shoreAt(rws+vec2( px,0.0)))+texAt(rel+vec2( px,0.0),twEff)*texW;
  float eU=shoreFix(eAt(llw+vec2(0.0, py),roughEff,decoK),ws,shoreAt(rws+vec2(0.0, py)))+texAt(rel+vec2(0.0, py),twEff)*texW;
  float eD=shoreFix(eAt(llw+vec2(0.0,-py),roughEff,decoK),ws,shoreAt(rws+vec2(0.0,-py)))+texAt(rel+vec2(0.0,-py),twEff)*texW;
  float nrm=${glF(NRM_K)}*(uPXPD/${glF(NRM_PX)})*uGain;
  vec3 nv=vec3((eL-eR)*nrm,(eU-eD)*nrm,1.0);
  /* 宏观坡法线系数 FX.macroNrm＝nrm 对基础坡度的响应之半（2·nrm/uPXPD ÷2），两套法线同量纲可直接相加 */
  float mnk=macroK(uGridBB.z,uGain);
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
  float slc=slopeSoft(sl);
  float dn=dot(normalize(vec3(sv*(sl>1e-6? slc/sl : 1.0),1.0)), uLight);
  float sh; vec3 shT; shadeOf(dn,sh,shT);
  float cav=cavOf(es-cd.x,uFStep,uGain);
  if(uRiv==1){ float sdd=riverSD(ll); if(sdd<1e8) rsd=sdd*uPXPDY; }   // 河取未扭曲位置：河是数据，与叠加层的线、拾取同一个位置
  float ec=rsd<0.0 && e>=ws-${EPS} ? ws-${glF(WATER.riverE)} : e;   // 陆上的河面＝紧贴判据线下的浅水（水段色阶最浅一档、满近岸带）
  col=elevRamp(ec,ws,dLat);   // 赋外层 col（此处若写 vec3 col 即遮蔽＝观感底图整幅黑）
  float zsn=0.0;
  if(ec>=ws-${EPS}){
    if(uZone==1) zoneCol(e,dLat,col,zsn);   // 气候分区：各档色阶与雪盖按权重混
    if(uBeach==1){ vec2 bd=bandAt(rws); col=mix(col, vec3(${FX.beachC.join(",")}), beachK(bd.x, e-bd.y)); }   // 滩带：水边的浅色带（先于类型色调：林地、沼泽照旧盖过它）
    if(mt.tintW>0.0) col=mix(col, fk>0.0 ? mix(mt.tint,mead,fk) : mt.tint, tintK(mt.tintW));   // 软过渡；林线以上的森林换草甸色
    // 生态辨识度：荒漠暖沙定调；沼泽湿绿+近景水洼/湿泥（键=材质权重 tw.y/tw.w，详见 material.ts）
    col=mix(col, vec3(${FX.sandC.join(",")}), sandK(mt.tw.y));
    if(mt.tw.w>${glF(FX.wMin)}){
      col=mix(col, vec3(${FX.marshC.join(",")}), marshK(mt.tw.w));
      float pg=poolGate(uPXPD*uGridBB.z,mt.tw.w,float(uPaper));
      if(pg>${glF(FX.wMin)}){
        vec2 pm=poolMask(poolN(rel));
        col=mix(col, vec3(${FX.mudC.join(",")}), pm.x*pg*float(${FX.mudMix}));
        col=mix(col, vec3(${FX.poolC.join(",")}), pm.y*pg*float(${FX.poolMix}));
      }
    }
    vec3 LA=lodF(float(${FX.albPx}));   // 反照率抖动：屏幕锚定低频，打破平色（整幅视角下门控为零）
    col*=albM(albAv(rel,LA),mt.albVar,gate(LA.x));
    float slp=length(nv.xy);    // 缩放无关坡度：陡处露岩（微八度让坡度随放大长细节，岩斑自然斑驳）
    float rk=rockK(slp,mt.rock);
    vec3 rockC=mix(vec3(${FX.rockC.map(c => glF(c)).join(",")}), vec3(${FX.rockC.map((c, i) => glF(c + FX.rockSpan[i])).join(",")}), rockT(e));
    col=mix(col, rockC, rk*float(${FX.rockMix}));
    // 雪按米落（material.snowSpec 同式：气候档基准 + 球面图随纬度；陡坡挂不住雪打六折）——色阶顶带只剩灰岩，白色归雪
    float snE=snowLine(uSnowE,dLat);
    float sn=(uZone==1 ? zsn : snowAt(snE,e))*snowSlope(slp);
    col=mix(col, vec3(${FX.snowC.join(",")}), sn);
    col=mix(col, vec3(${FX.airC.join(",")}), airK(e));   // 空气透视
    col*=sh*shT*(1.0-cav);
  } else {
    // 近岸浅水带：随缩放渐隐（px/° 区间见 FX.shoreLo/Hi）——整幅视角下固定高程区间摊成贴纸大光环
    col=mix(col, ${WG.shore}, shoreK(ec,ws,uPXPD*uGridBB.z));
    vec3 LW=lodF(float(${FX.wavePx}));  // 静态波纹（横向拉伸；无动画，尊重空闲降频）
    col*=waveM(waveWv(rel,LW),gate(LW.x));
  }
  }
  // 岸线（只给观感底图）描在岸值过零处：按高程梯度描会把重采样前的台阶再描一遍。fwidth 在分支外取＝一致控制流
  float sdc=shs/(fwidth(shs)*uDPR+1e-6);   // 到岸线的有向距离（CSS 像素，陆正水负）：墨宽随 uDPR，同 CPU 的 coastInk
  float coast=1.0-smoothstep(0.0,${glF(WATER.inkBandPx)},abs(sdc));
  if(rsd<1e8) coast=1.0-smoothstep(0.0,${glF(WATER.inkBandPx)},abs(min(sdc,rsd/uDPR)));   // 河与湖海并成一片水：岸线只描并集的边
  col=mix(col, ${WG.ink}, coast*${WATER.inkA}*(1.0-float(uMode)));
  // 网格内缩一格的图幅裁边：世界 bbox 外=深海，制图面在边缘塌向海——贴边假线截掉（neatline 惯例）
  if(uContour==1 && er>=ws-${EPS} && shs>=0.0 && rsd>=0.0 && rel.x>uGridBB.z && rel.y>uGridBB.z && rel.x<uGridSpan.x-uGridBB.z && rel.y<uGridSpan.y-uGridBB.z){
    // 等高线画在规则场制图面 er（晕渲是画，等高线是尺），按 contourK 着墨；岸线重采样后画面成水的像素不画（同 CPU：线只叠在陆地分支里）。
    // 间曲线的浮现门看 ±10 px 差分的**粗坡**，不看逐像素梯度：侵蚀微起伏让局部梯度远大于宏观坡，按它算线距会低估几十倍、平地上永远开不了门；
    // 虚线相位锚网格原点的像素坐标（平移不爬动），对 ±切向对称（CPU 的 y 轴反向也同相）
    // 线落在等距的**整数倍**上（高程自海面 0 起算，与光标读数同一把尺）：早先 +0.02 是为让最低那条压住水陆界，
    // 代价是每条线都偏 0.02×elevUnitM（战术图 40 m）＝注记读不出圆整数。0 米线仍贴着岸走（陆地一格内就跃过 0）。
    float eh=er;
    gWarp=vec2(0.0);   // 粗坡采样属制图面族（本块之后再无扭曲族采样）
    float kx=${glF(C.gcPx)}/uPXPD*uDPR, ky=${glF(C.gcPx)}/uPXPDY*uDPR;
    vec2 gc=vec2(ruleSmooth(ll+vec2(kx,0.0))-ruleSmooth(ll-vec2(kx,0.0)), ruleSmooth(ll+vec2(0.0,ky))-ruleSmooth(ll-vec2(0.0,ky)))/${glF(2 * C.gcPx)};   // ±10 CSS px 的差分÷20＝每 CSS px 的坡；再除 DPR 就成了每物理像素，高分屏上间曲线提前浮现
    float gsl=abs(gc.x)+abs(gc.y)+1e-7;
    vec2 tg=normalize(vec2(-gd.y,gd.x)+vec2(1e-9,0.0));
    float sdp=dot(tg,(ll-uGridBB.xy)*vec2(uPXPD,uPXPDY))/uDPR;
    float k=contourK(eh,uCStep,ad,gsl,sdp,0.0), kh=contourK(eh,uCStep,ad,gsl,sdp,float(${FX.haloPx}));
    // 亮晕只画核外环（kh−k），按底色亮度渐隐：暗坡上棕线与底同亮，靠环保证可见（判据见 material.FX.halo*）
    col=mix(col, vec3(${FX.haloC.join(",")}), haloK(dot(col,vec3(${FX.luma.join(",")})),k,kh));
    col=mix(col, vec3(${C.color.map(c => glF(c)).join(",")})/255.0, k);
  }
  // 图幅外纸色最后覆盖（放在全部计算之后＝fwidth 的一致控制流不受此分支影响）；图廓线由 overlay 层描
  if(uPaper==1 && (rel.x<0.0||rel.y<0.0||rel.x>uGridSpan.x||rel.y>uGridSpan.y)) col=vec3(${PAPER_RGB.map(c => glF(c)).join(",")})/255.0;
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

/* 上下文属性：全幅不透明（fragColor 恒 α=1）、无深度模板，合成走不透明路径；
   preserveDrawingBuffer＝渲染按需（render 的输入指纹没变就跳过，见 lastKey）的前提——不保留时缓冲在合成后即作废，
   跳过的那些帧里出图 / 缩略图 / 走查脚本 drawImage(#map) 拿到的是黑帧。代价是合成时多一次整幅拷贝。 */
const GL_ATTRS: WebGLContextAttributes = { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: true };

/** 探针：一次性 canvas 上把同一份着色器编译+链接一遍，成功才让真 canvas 走 GL。
    因 canvas 一旦 getContext("webgl2") 即永久锁进 GL 模式——若之后编译失败退 CPU，
    terrainCPU 的 getContext("2d") 会返 null 令首帧崩（审计：救命兜底自毁）。探针在真
    canvas 之前预判，用后即以 WEBGL_lose_context 释放。 */
function probeGL(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2", GL_ATTRS);
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
  const glMaybe = canvas.getContext("webgl2", GL_ATTRS);
  if (!glMaybe) return null;
  const gl = glMaybe;   // 固化非空绑定，供下方闭包捕获（避免联合类型收窄不传入闭包）

  let pr: WebGLProgram | null = null;
  let tex: WebGLTexture | null = null;    // 类型粗格纹理（TEXTURE0）
  /* 高程场纹理（侵蚀细分后维度 ≠ 粗格）：画面场与规则场各一份——TEXTURE1 绑本帧的画面（观感底图＝画面场，
     精修档在此；推演底图＝规则场），TEXTURE2 恒绑规则场供等高线取样（与光标读数同源）。两场同一对象时只建一份。 */
  interface FieldTex { tex: WebGLTexture | null; cols: number; rows: number; step: number; eroded: number; of: ElevField }
  let fDisp: FieldTex | null = null, fRule: FieldTex | null = null;
  let g: Grid | null = null;
  let lastField: ElevField | undefined, lastRule: ElevField | undefined;   // 存最近两场：上下文丢失恢复时重传
  let lastWS: Float32Array = new Float32Array(0);
  let texFor: Grid | null = null, texWS: Float32Array | null = null;   // 类型纹理建自哪份（网格, 水面）
  /* 上一帧的输入指纹：视口、画布像素、全部选项与上传代次都没变＝画布上已经是这一帧，直接跳过——
     悬停、点选、拖部队这些只动叠加层的交互曾让地形着色器每帧全幅重跑（核显 DPR 1.5 每帧 22～35 ms）。
     上传或上下文恢复即清空（画布内容已换）。 */
  let lastKey: string | null = null;
  /* 气候分区纹理（3/4＝权重、5＝观感表）：无分区时绑 1×1 占位，采样器恒完整 */
  let zw0: WebGLTexture | null = null, zw1: WebGLTexture | null = null, zlook: WebGLTexture | null = null;
  let zwFor: ZoneWeights | null = null, zlKey: string | null = null;
  /* 河段纹理（8＝河段、9＝桶表与段号）：没有河时绑 1×1 占位；按河段集引用换代重传 */
  let rseg: WebGLTexture | null = null, ridx: WebGLTexture | null = null, rivFor: RiverSet | null = null;
  /* 滩带场纹理（10 号单元）：只在画滩带的帧上建，按场数组的引用换代；不画时绑 1×1 占位 */
  let band: WebGLTexture | null = null, bandFor: Float32Array | null = null;
  function bandTex(data: Float32Array | null, cols: number, rows: number): void {
    if (band) gl.deleteTexture(band);
    band = gl.createTexture();
    gl.activeTexture(gl.TEXTURE10);
    gl.bindTexture(gl.TEXTURE_2D, band);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, data ? cols : 1, data ? rows : 1, 0, gl.RG, gl.FLOAT, data || new Float32Array(2));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    bandFor = data;
  }
  function zoneTex(unit: number, t: WebGLTexture | null, w: number, h: number, data: ArrayBufferView, float: boolean): WebGLTexture | null {
    if (t) gl.deleteTexture(t);
    const nt = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, nt);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    const flt = float ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, flt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, flt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    return nt;
  }
  const U = (n: string) => gl.getUniformLocation(pr!, n);
  /* 分块精修（core/tiles）：块放进纹理数组（6 号单元，一块一层），页表（7 号，R32I）记块号 → 层号；层按 LRU 复用，只给视口里的块，层数见 tileSlotsFor。
     没有块层时绑 1×1 占位（采样器恒完整）。块数组当不可变快照：层里存的数组与块层里的不是同一个＝要重传 */
  const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
  let tLayer: TileLayer | null = null, tVer = 0;
  let atlas: WebGLTexture | null = null, page: WebGLTexture | null = null, atlasFor: string | null = null;
  let slotTile: number[] = [], slotArr: (Float32Array | null)[] = [], slotUse: number[] = [], useTick = 0;
  function placeTileTex(K: number, N: number, nx: number, ny: number): void {
    if (atlas) gl.deleteTexture(atlas);
    if (page) gl.deleteTexture(page);
    atlas = gl.createTexture(); page = gl.createTexture();
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R32F, K, K, N);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, page);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32I, nx, ny, 0, gl.RED_INTEGER, gl.INT, new Int32Array(nx * ny).fill(-1));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    slotTile = new Array(N).fill(-1); slotArr = new Array(N).fill(null); slotUse = new Array(N).fill(0);
  }
  /** 视口里的块搬进显存并重写页表；块比层多先扩层（重建、全部重传）。扩到封顶也装不下＝false，这一帧整幅不用块 */
  function residentTiles(L: TileLayer, view: BBox): boolean {
    const g = L.geom, K = g.P * g.sx, FC = g.cols * g.sx, FR = g.rows * g.sx;
    const key = `${K}|${g.nx}x${g.ny}`;
    if (atlasFor !== key) { placeTileTex(K, TILE_SLOTS, g.nx, g.ny); atlasFor = key; }
    const want = tilesInView(g, L.tiles.keys(), view), n = tileSlotsFor(slotTile.length, want.length, K, maxLayers);
    if (!n) return false;
    if (n > slotTile.length) placeTileTex(K, n, g.nx, g.ny);
    let dirty = false;
    for (let s = 0; s < slotTile.length; s++) {
      const t = slotTile[s];
      if (t >= 0 && L.tiles.get(t) !== slotArr[s]) { slotTile[s] = -1; slotArr[s] = null; dirty = true; }   // 块换了或没了
    }
    for (const [i, s] of tileResidency(slotTile, slotUse, want, ++useTick)) {
      const a = L.tiles.get(i)!, tx = i % g.nx, ty = (i / g.nx) | 0, w = Math.min(K, FC - tx * K), h = Math.min(K, FR - ty * K);
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, s, w, h, 1, gl.RED, gl.FLOAT, a);
      gl.activeTexture(gl.TEXTURE0);
      slotArr[s] = a; dirty = true;
    }
    if (dirty) {
      const pg = new Int32Array(g.nx * g.ny).fill(-1);
      for (let s = 0; s < slotTile.length; s++) if (slotTile[s] >= 0) pg[slotTile[s]] = s;
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, page);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, g.nx, g.ny, gl.RED_INTEGER, gl.INT, pg);
      gl.activeTexture(gl.TEXTURE0);
    }
    return true;
  }

  function riverTex(s: RiverSet | null): void {
    for (const t of [rseg, ridx]) if (t) gl.deleteTexture(t);
    let T = s ? riverTexels(s) : null;
    if (T && Math.max(T.segRows, T.idxRows) > maxTex) { console.warn(`河段纹理 ${RIV_TEX_W}×${Math.max(T.segRows, T.idxRows)} 超出本机纹理上限 ${maxTex}，宽河照旧画成线`); T = null; }
    const mk = (unit: number, ifmt: number, fmt: number, type: number, rows: number, data: ArrayBufferView): WebGLTexture | null => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, T ? RIV_TEX_W : 1, rows, 0, fmt, type, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.activeTexture(gl.TEXTURE0);
      return t;
    };
    rseg = mk(8, gl.RGBA32F, gl.RGBA, gl.FLOAT, T ? T.segRows : 1, T ? T.seg : new Float32Array(4));
    ridx = mk(9, gl.R32I, gl.RED_INTEGER, gl.INT, T ? T.idxRows : 1, T ? T.idx : new Int32Array(1));
    rivFor = s; rivOk = !!T;
  }
  let rivOk = false;
  /* 建程序 + 设常量 uniform（创建时 + webglcontextrestored 后重跑）。 */
  function initProgram(): boolean {
    pr = compileProgram(gl);
    if (!pr) return false;
    gl.useProgram(pr);
    gl.uniform1i(U("uGrid"), 0);
    gl.uniform1i(U("uField"), 1);
    gl.uniform1i(U("uRule"), 2);
    gl.uniform1i(U("uZW0"), 3); gl.uniform1i(U("uZW1"), 4); gl.uniform1i(U("uZLook"), 5);
    gl.uniform1i(U("uTAtlas"), 6); gl.uniform1i(U("uTPage"), 7);
    gl.uniform1i(U("uRSeg"), 8); gl.uniform1i(U("uRIdx"), 9); gl.uniform1i(U("uBand"), 10);
    riverTex(null); bandTex(null, 1, 1);
    placeTileTex(1, 1, 1, 1); atlasFor = null;   // 占位；块层来了按它的几何重建
    zw0 = zoneTex(3, null, 1, 1, new Uint8Array(4), false); zw1 = zoneTex(4, null, 1, 1, new Uint8Array(4), false);
    zlook = zoneTex(5, null, 1, 1, new Float32Array(4), true); zwFor = null; zlKey = null;
    gl.uniform3f(U("uLight"), SHADE_LIGHT[0], SHADE_LIGHT[1], SHADE_LIGHT[2]);
    const comps = allComposites();   // 30 个复合，顺序与 compositeIndex 对齐（旧 8 类落在各自复合上、色/tint 逐位复现）
    gl.uniform3fv(U("uTColor[0]"), comps.flatMap(cc => hexV(terrainProps(cc).color)));
    gl.uniform3fv(U("uTint[0]"), comps.flatMap(cc => { const t = terrainProps(cc).tint; return t ? [t[0], t[1], t[2]] : [-1, -1, -1]; }));
    const mats = materialTable();    // 渲染材质（同序；render/material.ts 真源，CPU 兜底同表）
    gl.uniform4fv(U("uMatA[0]"), mats.flatMap(m => [m.canopy, m.dune, m.ridge, m.marsh]));
    gl.uniform4fv(U("uMatB[0]"), mats.flatMap((m, i) => [m.rough, m.albVar, m.rock, terrainProps(comps[i]).lf === "water" ? 1 : 0]));
    return true;
  }
  /* 场的边长超出本机纹理上限就不能原样上传：超限的 texImage2D 只置错误码、不抛异常，采样恒零＝整幅地形静默变白。
     画面场超限改画规则场；规则场也超限就合并成放得下的一份（等高线随之略离读数）。
     合并的那份按源场记住：纹理按场对象留用，每次现算一份＝每次上传都重传 */
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  let texWarned = false;
  const shrunk = new WeakMap<ElevField, ElevField>();
  const fits = (f: ElevField): boolean => f.cols <= maxTex && f.rows <= maxTex;
  const fitted = (f: ElevField): ElevField => {
    if (fits(f)) return f;
    let s = shrunk.get(f);
    if (!s) shrunk.set(f, s = shrinkField(f, Math.ceil(Math.max(f.cols, f.rows) / maxTex)));
    return s;
  };
  /* 高程场纹理：R=高程。在 1 号单元上建、建完还原到 0 号 */
  function fieldTex(field: ElevField): FieldTex {
    const fc = field.cols, fr = field.rows, fd = field.data;
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, fc, fr, 0, gl.RED, gl.FLOAT, fd);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);   // 常规活动纹理还原到 0 号（类型纹理绑定预期）
    return { tex: t, cols: fc, rows: fr, step: field.step, eroded: field.eroded ? 1 : 0, of: field };
  }
  /* 场纹理按 ElevField 引用留用：只换画面场（叠涂改增量、精修）时规则场不动——不留用就是每次多传一份 8 MB 的规则场 */
  const heldTex = (f: ElevField): FieldTex | null => fDisp && fDisp.of === f ? fDisp : fRule && fRule.of === f ? fRule : null;
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
  function doUpload(grid: Grid, wsurf: Float32Array, fieldIn: ElevField, ruleIn: ElevField) {
    if (!pr) return;
    const rule = fitted(ruleIn), field = fits(fieldIn) ? fieldIn : rule;
    if ((field !== fieldIn || rule !== ruleIn) && !texWarned) {
      texWarned = true;
      console.warn(`高程场 ${fieldIn.cols}×${fieldIn.rows} 超出本机纹理上限 ${maxTex}，画面改用 ${field.cols}×${field.rows} 的一份（地形仍可用，少的是细节）`);
    }
    /* 类型粗格纹理：R=水面高程（core/elev.waterSurface）G=复合索引（core/constants.compositeIndex）。
       同一 Grid 实例配同一份水面（两者都按 Grid 记忆）＝只动了高程的重建，纹理原样留用不重传 */
    if (!(tex && grid === texFor && wsurf === texWS)) {
      if (tex) gl.deleteTexture(tex);
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
      texFor = grid; texWS = wsurf;
    }
    const nd = heldTex(field) || fieldTex(field);
    const nr = rule === field ? nd : heldTex(rule) || fieldTex(rule);
    for (const t of new Set([fDisp, fRule])) if (t && t !== nd && t !== nr) gl.deleteTexture(t.tex);   // 旧的两份里没被留用的删掉
    fDisp = nd; fRule = nr;
    lastKey = null;
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
  const onRestored = () => { tex = null; fDisp = fRule = null; lastKey = null; zw0 = zw1 = zlook = null; atlas = page = null; rseg = ridx = null; rivFor = null; band = null; name = queryName(); if (initProgram() && g && lastField && lastRule) doUpload(g, lastWS, lastField, lastRule); };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    canvas, kind: "webgl2",
    uploadGrid(grid: Grid, wsurf: Float32Array, field: ElevField, rule: RuleField) {
      g = grid; lastWS = wsurf; lastField = field; lastRule = rule;
      doUpload(grid, wsurf, field, rule);
    },
    uploadTiles(layer: TileLayer | null) { tLayer = layer; tVer++; lastKey = null; },
    render(viewBB: BBox, opts: TerrainRenderOpts = {}) {
      const f = opts.flat ? fRule : fDisp;
      if (!g || !pr || !f || !fRule) return;
      const S = opts.snow, Z = opts.zones, H = canvas.height, [vw, vh] = opts.px ?? [canvas.width, H];
      const TL = opts.flat ? null : tLayer, tw = TL ? tileWeight(TL.geom.step * vh / (viewBB.latMax - viewBB.latMin) / (opts.dpr ?? 1)) : 0;
      /* 门槛往水那边让百万分之一：Float32 的真宽与门槛舍入后与叠加层的判定差一点时，宁可水与线叠着也别空一截 */
      const RV = opts.flat ? undefined : opts.rivers, rthr = RV ? RV.thr * (1 - 1e-6) : 0, rivOn = !!RV && RV.set.gmax >= rthr;
      const key = `${viewBB.lonMin},${viewBB.latMin},${viewBB.lonMax},${viewBB.latMax}|${vw}x${vh}/${H}|${+!!opts.flat}${+!!opts.contour}${+!!opts.wrap}${+!!opts.paper}${+(opts.beach !== false)}`
        + `|${opts.cStep}|${opts.dpr}|${opts.gain}|${opts.slopeK ?? 0}|${S ? `${S.base},${S.lat},${S.refM},${S.unitM}` : ""}|${opts.clim ? opts.clim.key : ""}|${Z ? `${Z.wt.id}:${Z.looks.key}` : ""}|${tw > 0 ? `${tVer}:${tw}` : ""}|${rivOn ? `${RV!.set.id}:${RV!.thr}` : ""}`;
      if (key === lastKey) return;   // 画布上已是这一帧
      lastKey = key;
      const bf = opts.beach !== false && !opts.flat ? bandField(g, lastWS) : null;
      if (bf !== bandFor) bandTex(bf, g.cols, g.rows);
      gl.viewport(0, H - vh, vw, vh);   // 可见区贴画布顶；GL 原点在左下
      bindField(1, f, "uFDim", "uFStep");
      gl.uniform1f(U("uEroded"), f.eroded);
      bindField(2, fRule, "uRDim", "uRStep");
      gl.uniform4f(U("uViewBB"), viewBB.lonMin, viewBB.latMin, viewBB.lonMax, viewBB.latMax);
      gl.uniform2f(U("uRes"), vw, H);
      gl.uniform1f(U("uPXPD"), vw / (viewBB.lonMax - viewBB.lonMin));
      gl.uniform1f(U("uPXPDY"), vh / (viewBB.latMax - viewBB.latMin));
      gl.uniform1i(U("uMode"), opts.flat ? 1 : 0);
      gl.uniform1i(U("uContour"), opts.contour ? 1 : 0);
      gl.uniform1f(U("uCStep"), opts.cStep || CONTOUR.stepDef);
      gl.uniform1f(U("uDPR"), opts.dpr ?? 1);
      gl.uniform1i(U("uWrap"), opts.wrap ? 1 : 0);
      gl.uniform1i(U("uPaper"), opts.paper ? 1 : 0);
      gl.uniform1i(U("uBeach"), opts.beach !== false ? 1 : 0);
      gl.uniform1f(U("uSnowE"), S ? S.base : 1e9);
      gl.uniform1f(U("uSnowLat"), S && S.lat ? 1 : 0);
      gl.uniform1f(U("uSnowRef"), S ? S.refM : 0);
      gl.uniform1f(U("uSnowUnit"), S ? 1 / S.unitM : 0);
      const C = opts.clim;
      gl.uniform1i(U("uClim"), C ? 1 : 0);
      gl.uniform1i(U("uClimN"), C ? C.n : 0);
      if (C) {
        gl.uniform4fv(U("uClimRamp[0]"), C.ramp);
        gl.uniform1f(U("uTreeE"), C.treeE); gl.uniform1f(U("uTreeBand"), C.band);
        gl.uniform3f(U("uMeadow"), C.meadow[0] / 255, C.meadow[1] / 255, C.meadow[2] / 255);
      }
      gl.uniform1i(U("uZone"), Z ? 1 : 0);
      if (Z) {
        if (Z.wt !== zwFor) {
          zw0 = zoneTex(3, zw0, Z.wt.cols, Z.wt.rows, Z.wt.tex0, false); zw1 = zoneTex(4, zw1, Z.wt.cols, Z.wt.rows, Z.wt.tex1, false);
          zwFor = Z.wt;
        }
        if (Z.looks.key !== zlKey) { zlook = zoneTex(5, zlook, ZLOOK_W, ZONE_N, zoneLookTexels(Z.looks), true); zlKey = Z.looks.key; }
        gl.uniform4f(U("uZoneBB"), Z.wt.bb.lonMin, Z.wt.bb.latMin, Z.wt.cols * Z.wt.pd, Z.wt.rows * Z.wt.pd);
      }
      const tOn = !!TL && tw > 0 && residentTiles(TL, viewBB);
      gl.uniform1f(U("uTW"), tOn ? tw : 0);
      if (tOn) {
        const tg = TL!.geom;
        gl.uniform1f(U("uTStep"), tg.step);
        gl.uniform2i(U("uTDim"), tg.cols * tg.sx, tg.rows * tg.sx);
        gl.uniform1i(U("uTK"), tg.P * tg.sx);
      }
      if (rivOn && RV!.set !== rivFor) riverTex(RV!.set);
      gl.uniform1i(U("uRiv"), rivOn && rivOk ? 1 : 0);
      if (rivOn && rivOk) {
        const s = RV!.set;
        gl.uniform4f(U("uRivA"), s.ox, s.oy, s.bs, rthr);
        gl.uniform2i(U("uRivN"), s.nx, s.ny);
      }
      gl.uniform1f(U("uGain"), opts.gain ?? 1);
      gl.uniform1f(U("uSlopeK"), opts.slopeK ?? 0);
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
      for (const t of [zw0, zw1, zlook, atlas, page, rseg, ridx]) if (t) gl.deleteTexture(t);
      dropFieldTex();
      if (pr) gl.deleteProgram(pr);
    }
  };
}
