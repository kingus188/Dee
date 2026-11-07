import { useState } from "react";
import { appearanceSizes, defaultAppearance, readAppearance, saveAppearance } from "./appearance.js";
import type { Appearance } from "./appearance.js";

const sizeLabels = { 90: "小", 100: "默认", 110: "大" };

export function AppearanceSettings() {
  const [value, setValue] = useState(readAppearance);
  const [saved, setSaved] = useState(true);
  function change(next: Appearance) {
    setValue(next);
    setSaved(saveAppearance(next));
  }
  return <section className="appearance-settings settings-form" aria-labelledby="appearance-title">
    <div className="appearance-heading"><h2 id="appearance-title">外观</h2><button className="text-button" type="button" disabled={value.font === 100 && value.components === 100} onClick={() => change({ ...defaultAppearance })}>恢复默认</button></div>
    {([{ key: "font", label: "字体大小" }, { key: "components", label: "组件大小" }] as const).map(({ key, label }) => <div className="appearance-row" key={key}>
      <span id={`appearance-${key}`}>{label}</span>
      <div className="appearance-options" role="group" aria-labelledby={`appearance-${key}`}>
        {appearanceSizes.map(size => <button key={size} type="button" aria-pressed={value[key] === size} onClick={() => change({ ...value, [key]: size })}>{sizeLabels[size]}</button>)}
      </div>
    </div>)}
    <p className="settings-field-hint">立即生效，仅保存在当前设备。</p>
    {!saved && <p className="settings-error" role="alert">已应用，本机暂时无法保存设置，重新打开后将恢复原设置。</p>}
  </section>;
}
