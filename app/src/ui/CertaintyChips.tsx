/* 可靠性档位 chips（2026-07 特化柱B）：地点表单与连线表单共用。
   三档＝确证（缺省，不落盘）/ 推断 / 传说；渲染映射见 core/constants.certaintyStyle。
   非受控（同两表单其余字段的 defaultValue 之规）：选中态存在 DOM 的 aria-pressed 上，
   提交时由 readCertainty 读回——避免为一枚 chip 引入表单级 state 而牵动整表重渲。 */
import { CERTAINTY, CERTAINTY_ORDER } from "../core/constants.ts";

const OPTS: [string, string][] = [["", "确证"], ...CERTAINTY_ORDER.map(k => [k, CERTAINTY[k].名] as [string, string])];

export function CertaintyChips({ id, value }: { id: string; value?: string }) {
  const cur = value && value in CERTAINTY ? value : "";
  return (
    <div class="frow"><label>可靠性（史料/考据把握；缺省＝确证，不写入存档）</label>
      <div class="chips" id={id}>
        {OPTS.map(([v, 名]) => (
          <button key={v || "sure"} type="button" class="ch tr" data-cv={v} aria-pressed={cur === v}
            onClick={ev => {
              const b = ev.currentTarget as HTMLButtonElement;
              b.parentElement?.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
            }}>{名}</button>
        ))}
      </div>
    </div>
  );
}

/** 读回选中档位（""＝确证）；找不到容器时返回 ""＝确证，与缺省一致 */
export function readCertainty(root: HTMLElement | null | undefined, id: string): string {
  const b = root?.querySelector<HTMLElement>("#" + id + " button[aria-pressed=\"true\"]");
  return (b && b.dataset.cv) || "";
}
