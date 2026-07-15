/* UI 挂载器：工具轨/上下文抽屉/检查器渲染进 .main 的透明挂点（.mount，
   display:contents 使组件根节点直接参与弹性布局）；抽屉重开页签在画布区 #cvTabMount；
   时间坞组件直渲 footer#dock、搜索进顶栏 #searchWrap；悬浮笔刷框/作战线框仍在画布容器；
   开始界面（地图库）/帮助/设置弹层/开图加载舞台为全屏覆盖层挂点。 */
import { render } from "preact";
import { ToolRail } from "./ToolRail.tsx";
import { Drawer, DrawerTab } from "./Drawer.tsx";
import { Inspector } from "./Inspector.tsx";
import { TimeDock } from "./TimeDock.tsx";
import { LoadStage } from "./LoadStage.tsx";
import { SearchBox } from "./SearchBox.tsx";
import { OpBox } from "./OpBox.tsx";
import { FpropsBar } from "./FpropsBar.tsx";
import { Toast } from "./Toast.tsx";
import { HomePanel } from "./HomePanel.tsx";
import { HelpOverlay } from "./HelpOverlay.tsx";
import { SettingsOverlay } from "./SettingsOverlay.tsx";

export function mountUI(): void {
  const rail = document.getElementById("railMount");
  if (rail) render(<ToolRail />, rail);
  const dw = document.getElementById("drawerMount");
  if (dw) render(<Drawer />, dw);
  const insp = document.getElementById("inspMount");
  if (insp) render(<Inspector />, insp);
  const tab = document.getElementById("cvTabMount");
  if (tab) render(<DrawerTab />, tab);
  const tb = document.getElementById("dock");
  if (tb) render(<TimeDock />, tb);
  const ls = document.getElementById("stageMount");
  if (ls) render(<LoadStage />, ls);
  const sw = document.getElementById("searchWrap");
  if (sw) render(<SearchBox />, sw);
  const bm = document.getElementById("fpropsMount");
  if (bm) render(<FpropsBar />, bm);
  const om = document.getElementById("opMount");
  if (om) render(<OpBox />, om);
  const tm = document.getElementById("toastMount");
  if (tm) render(<Toast />, tm);
  const hm = document.getElementById("homeMount");
  if (hm) render(<HomePanel />, hm);
  const ovl = document.getElementById("ovlMount");
  if (ovl) render(<><HelpOverlay /><SettingsOverlay /></>, ovl);
}
