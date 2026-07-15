<div align="center">

# 舆图 · Chorograph

**浏览器端的「分析型」世界地图工具 —— 为世界观搭建与小说创作而生**

<sub><i>A browser-based analytical world-map tool for worldbuilding &amp; fiction writing.</i></sub>

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) &nbsp;·&nbsp; WebGL2 · PWA · 单文件产物

</div>

## 这是什么

舆图把**距离、行军天数、势力范围、战役位置**这些容易写崩的设定，放进一张会自洽计算的地图里——同时具备 Inkarnate 式的手绘地形/布景编辑。它以 **WebGL2** 渲染地形（无可用 GPU 时自动退回 Canvas2D），**A\* 寻路跑在 Web Worker**，用 **IndexedDB** 或本地文件夹作图库，并可构建为一个**自包含的单文件 HTML**（离线可用、可作 PWA 安装、`file://` 双击即跑）。

- ⏳ **时间为基底**：几乎每个对象都能带存在时段（`since/until`）。拖动纪年时间轴，城池换旗、势力范围伸缩、战役依年份显隐，寻路也按当年的道路与地形计算。支持自定义历法（纪元/月长可配）或真实地球历（儒略/格里高利、公元前），时间轴可细化到**日内时刻**。
- 🌍 **双世界模型**：`球面星球`（大圆距离 + 经度环绕）或 `平面·天圆地方`（直角坐标、有边界）。切换即全局重算里程 / 天数。
- 🧭 **A\* 地形寻路 + 行军报告**：陆军翻山慢、水军只走水域、飞行直线；给出里程 / 迂回率 / 各速度档天数 / 沿途地形与途经地。
- 🗺 **程序化生成地形**：新建地图可按种子生成海岸线 / 山川 / 生态的可信大陆，可选**大陆 / 群岛**风格，一键换一块；另有内置示例大陆与「空白平原」起手。
- ⛰ **高程场与河流真宽**：程序化地势起伏 + 高程画笔 + 等高距标定；河流可按真实水面宽度渲染，也可自由描线成河。
- ⚔ **战术地图·兵棋推演**：战役事件点一键**生成小范围战场图**（地形 / 地点 / 派系按当年快照继承、网格加密）——时间轴细化到日，兵棋标准框**部队**逐日记航点、回放行军、**A\* 可达性校验**（超速标红）、视野 / 火力射程圈、交战 / 对峙 / 溃退状态；与战略图**双向链接**互跳。
- 🎨 **手绘编辑**：地点、连线（道路 / 河流 / 商路）、势力涂域、地貌×生态双轴地形笔刷、布景印章（可上传自定义图形）、战役作战线（攻势 / 防线）、自由文本标注。
- 📁 **两种图库**：默认浏览器本地存储（IndexedDB），或把某个本地文件夹当图库、**直接读写其中的 `.json`**（需 Edge / Chrome 经 localhost / https）。
- 🔗 **回链 Obsidian**：地点可用 `obsidian://` 双链直开你的设定库。

## 快速开始

```bash
cd app
npm install
npm run dev          # 开发服务器（http://localhost:5173，HMR）
npm run build        # 构建单文件产物 app/dist/index.html（JS/CSS/Worker 全内联 + PWA 伴生件）
npm run preview      # 本地验证构建产物（http://localhost:4173）
```

构建出的 `dist/index.html` 自包含，可直接双击（`file://`）运行；托管到任意静态服务器即可作 PWA 安装、离线使用。推荐 **Edge / Chrome** 以获得完整功能（「文件夹图库」依赖 File System Access API）。开发模式下可用 URL 深链直达，例如 `#sample=井陉之战-战术.json` 载入仓库内的示例地图。

## 示例 · 战术推演图

仓库内附两张真实战役的战术推演图（`井陉之战-战术.json` / `鄱阳湖之战-战术.json`）作为可载入示例——展示战役当年快照、时间轴逐日回放、部队航点与 A\* 可达性校验、视野 / 火力圈等战术图能力。开发模式下经深链 `#sample=<文件名>` 直接载入。

## 测试

```bash
cd app
npm test             # node:test 套件（需 Node ≥ 23.6，零原生依赖）
npm run typecheck    # tsc --noEmit
```

核心数学（投影 / 噪声 / 地形判定 / 历法 / 距离 / 寻路）以**黄金基准**回归锁定——断言逐位复现，保证程序化地形与既有存档不随重构走样。每次 push / PR 由 GitHub Actions 自动跑测试、类型检查与单文件构建。

## 项目结构

| 路径 | 作用 |
|---|---|
| `app/` | 应用本体（Vite + TypeScript + Preact / signals） |
| `app/src/core/` | 纯逻辑：几何 / 投影 / 噪声 / 地形 / 历法 / 距离 / A\* 寻路（黄金基准平价锁定） |
| `app/src/render/` | 渲染层：WebGL2 地形 + Canvas2D 覆盖层 / 兵棋 / 布景 / 分析 |
| `app/src/data/` | IndexedDB 图库 / 文件夹图库 |
| `app/src/worker/` | 寻路 Web Worker |
| `井陉之战-战术.json`, `鄱阳湖之战-战术.json` | 可载入的战术图示例 |

## 许可

以 [MIT](LICENSE) 授权 © 2026 Lynthar
