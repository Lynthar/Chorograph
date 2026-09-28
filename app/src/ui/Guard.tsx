/* 域级错误隔离：一栏渲染抛错只把这一栏换成提示条，别的栏与画布照常；「重试」重挂这一栏（数据修好或换了选中即恢复） */
import { Component, Fragment, type ComponentChildren } from "preact";
import { errText } from "../core/util.ts";

export class Guard extends Component<{ name: string; children?: ComponentChildren }, { err: unknown; n: number }> {
  state = { err: null as unknown, n: 0 };
  componentDidCatch(err: unknown): void {
    console.error(`「${this.props.name}」渲染出错：`, err);   // 响而不崩：e2e 与控制台都看得见
    this.setState({ err });
  }
  render() {
    const { err, n } = this.state;
    if (err) return (
      <div class="guard-err" role="alert">
        ⚠ {this.props.name}出错：{errText(err)}（其余功能不受影响）
        <button type="button" class="tbtn" onClick={() => this.setState({ err: null, n: n + 1 })}>重试</button>
      </div>
    );
    return <Fragment key={n}>{this.props.children}</Fragment>;
  }
}
