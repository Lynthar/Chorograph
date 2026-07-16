/* 舆图数据模型类型（对应 v0.14 存档 schema；键名中英混用是历史现状，保持不变）。
   所有对象可带可选 since/until（时间为基底）：战略图存年份，战术图存日戳 T。 */

export type WorldModel = "sphere" | "flat";
export type TerrainMode = "auto" | "plain" | "island" | "sample";
export type GenStyle = "continent" | "archipelago";
export type TerrainId =
  | "plain" | "coast" | "hill" | "forest"
  | "desert" | "marsh" | "mountain" | "water";
/* 两轴地形（重构 A）：地貌 × 生态。grid.cells / terrainOverrides.t 存复合串
   "地貌" 或 "地貌/生态"（生态=none 时省略）。旧 8 元 TerrainId 是兼容子集，迁移/派生见 constants.ts。 */
export type Landform = "plain" | "coast" | "hill" | "mountain" | "water";
export type Ecotype = "none" | "forest" | "grassland" | "marsh" | "desert";
/** 复合地形串（如 "plain" / "hill/forest" / "plain/marsh"）；旧 TerrainId 亦为合法复合串 */
export type Composite = string;
export type Arm = "land" | "water" | "air";

export interface BBox { lonMin: number; lonMax: number; latMin: number; latMax: number }

export interface CalendarCfg {
  kind?: "custom" | "earth";  // earth=真实地球历法（儒略/格里高利，日戳=JDN）；缺省 custom
  months?: number; dpm?: number;   // custom 用；earth 忽略
  era?: string;               // custom 纪元前缀（默认 "SE"）；earth 固定「公元/公元前」
}

/** 战术图 ↔ 战略图 双向链接（meta.parent / ev.tacmap） */
export interface TacParent { map?: string; mapName?: string; event?: string; eventName?: string }

export interface Meta {
  名称?: string;
  说明?: string;
  版本?: string | number;
  更新?: string;              // YYYY-MM-DD（导出/新建时盖章）
  worldModel?: WorldModel;
  planetRadiusKm?: number;
  kmPerDeg?: number;          // 平面世界每度里程；留空按 2πR/360 换算
  bbox?: BBox;
  terrain?: TerrainMode;
  genSeed?: number;
  genStyle?: GenStyle;
  vault?: string;
  mapKind?: "tactical";
  calendar?: CalendarCfg;     // 战术图历法（默认 12 月 × 30 日）
  parent?: TacParent;
  battleYear?: number;        // 战术图对应的战役年份
  tacSpan?: [number, number]; // 战术图时间轴默认范围（日戳）
  relief?: number;            // 程序化地势起伏幅度 0..1（缺省=无——旧图高程场逐位不变）
  elevUnitM?: number;         // 1 抽象高程单位 = 多少米（缺省 2000；等高距/光标高程换算用）
  contourM?: number;          // 最细等高距（米）：缩放自适应 ×2 阶梯的锚/下限；缺省 10m
  view?: { lon0: number; lat0: number; degPerPx0?: number; degPerPx?: number };   // 世界默认视角（数据惯例用 degPerPx0；会话快照用 degPerPx）
}

export interface Timed { since?: number | null; until?: number | null }

export interface Owner extends Timed { faction?: string | null }

export interface PaintLayer extends Timed { cells: [number, number][] }

export interface Faction extends Timed {
  id: string; 名称?: string; color?: string; 阵营?: string;
  territory?: string[];        // 显式影响范围=地点 id 列表（虚线圈；非领土）
  paint?: PaintLayer[];
  link?: string;
  [k: string]: unknown;
}

export interface Op extends Timed {
  kind: "attack" | "defense";
  pts: [number, number][];
  side?: string | null; troop?: string; label?: string; w?: number; reverse?: boolean;
  dash?: boolean;   // 虚线（佯动/隐蔽机动/撤退/复原推断）
  /* since/until（自 Timed）：分相位显隐——缺省=只在事件当年/当日显示（旧语义） */
}

export interface WorldNode extends Timed {
  id: string; 名称?: string;
  lon: number; lat: number;
  type: string;
  faction?: string | null;
  owners?: Owner[];
  radiusKm?: number;
  字段?: Record<string, string>;
  note?: string; link?: string;
  /* 标注（type:"label"）专属：自由文本注记（钟点/风向/兵力/史料争议…；名称=文本，可多行） */
  fs?: number;                // 字号 px（缺省 13；11=小注 17=标题）
  pin?: string;               // 屏幕角固定（nw/ne/sw/se）：帧标题/图注块——不随地图平移，按时段轮换
  /* 事件点（type:"event"）专属 */
  evtype?: string; year?: number; sides?: string; result?: string;
  ops?: Op[];
  tacmap?: { id?: string; file?: string; name?: string };
  ranges?: { 名称?: string; km: number }[];
  [k: string]: unknown;
}

export interface Edge extends Timed {
  from?: string; to?: string;  // 经典边（道路/商路/锚端点河）必填；自由画河用 pts、两端皆无
  pts?: [number, number][];    // 自由画河道折线（[lon,lat]…）：有 pts≥2 即自由河，渲染/拾取/量长沿 pts（Chaikin 柔化）；旧 from/to 河走原路径
  type: "road" | "river" | "trade";
  名称?: string;
  widthM?: number;            // 河流真实水面宽（米）：按地理尺度渲染线宽（缺省=样式底宽 2.6px）
  字段?: Record<string, string>;
  note?: string;
  [k: string]: unknown;
}

export interface Decor extends Timed {
  id: string; lon: number; lat: number; kind: string; size?: number;   // kind="img:<assetId>"=自定义印章，否则内置矢量
}

/** 自定义印章资产（每图内嵌 base64；上传即降采样 ≤256px WebP-alpha）。decor 以 kind:"img:<id>" 引用；
    浏览器印章池（localStorage 跨图复用）见 ui/stamps.ts。 */
export interface Asset { id: string; name?: string; src: string; w: number; h: number }

export interface TerrainOverride extends Timed {
  lon: number; lat: number; t: Composite;   // 复合串（"地貌"/"地貌/生态"；旧 TerrainId 是兼容子集，建格时经 canonComposite 归一）
  step?: number;              // 涂改块尺寸（战术图继承的战略图涂改=1°粗块）
}

/** 高程涂改（渲染层专用；不影响地形类型/寻路）：图章盒内加性叠加 dh（抽象单位，elevUnitM 换算米） */
export interface HeightOverride extends Timed {
  lon: number; lat: number; dh: number;
  step?: number;              // 图章尺寸（同 TerrainOverride 语义；战术图继承的战略图涂改=1°粗块）
}

export interface TrackPt {
  t: number; lon: number; lat: number;
  st?: string;                // 状态（UNIT_STATUS 键：battle/standoff/rout）：自该航点起生效到下一航点；缺省=行军/常态
}

export interface Unit extends Timed {
  id: string; 名称?: string;
  kind: string; arm?: Arm;
  strength?: string | number;
  speed?: number;             // 可覆速度 km/日（缺省用兵种表默认 v）
  faction?: string | null;
  track: TrackPt[];
  ranges?: { 名称?: string; km: number }[];   // 旧多圈火力（v0.14 遗留）：只读回退——渲染取首条，表单保存归一为 range
  range?: number;             // 火力投射半径 km（与 vision 同机制：数字输入+圈上手柄拖动、拖近零清除）
  vision?: number;            // 视野/侦察半径 km（浅色半透明圆；选中后圈左手柄可拖动调节）
  note?: string;
  [k: string]: unknown;
}

export interface World {
  meta: Meta;
  factions: Faction[];
  nodes: WorldNode[];
  edges: Edge[];
  decor: Decor[];
  terrainOverrides: TerrainOverride[];
  heightOverrides?: HeightOverride[];   // 可选（不入 normalizeWorld 数组清单——旧档形状不变）
  units: Unit[];
  assets?: Asset[];                     // 自定义印章资产（可选键，缺省不落盘——同 heightOverrides）
  [k: string]: unknown;
}

/** 旧代码多处的兜底 bbox（地形网格/涂域/程序化生成共用） */
export const DEFAULT_BBOX: BBox = { lonMin: 82, lonMax: 130, latMin: 22, latMax: 54 };
