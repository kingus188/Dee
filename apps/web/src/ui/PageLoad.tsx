import { Component, Suspense, type ReactNode } from "react";

export class PageLoad extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="page-load-state" role="alert"><span className="page-load-mark page-load-mark-error" aria-hidden="true">!</span><div className="page-load-copy"><p className="page-load-title">这一页暂时没有打开</p><p className="page-load-caption">检查网络后，重新加载再试。</p></div><button className="page-load-retry" type="button" onClick={() => window.location.reload()}>重新加载</button></div>;
    return <Suspense fallback={<div className="page-load-state" role="status" aria-live="polite">
      <div className="page-load-visual" aria-hidden="true"><span className="page-load-ring" /><span className="page-load-mark">D<span /></span></div>
      <div className="page-load-copy"><p className="page-load-title">正在打开界面</p><p className="page-load-caption">小 D 正在为你准备这一页</p></div>
      <span className="page-load-progress" aria-hidden="true" />
    </div>}>{this.props.children}</Suspense>;
  }
}
