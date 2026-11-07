export const appearanceSizes = [90, 100, 110] as const;
export type AppearanceSize = typeof appearanceSizes[number];
export type Appearance = { font: AppearanceSize; components: AppearanceSize };
export const defaultAppearance: Appearance = { font: 100, components: 100 };
const storageKey = "dee.appearance";

function validSize(value: unknown): value is AppearanceSize {
  return appearanceSizes.some(size => size === value);
}

export function readAppearance(): Appearance {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
    if (value && typeof value === "object" && "font" in value && "components" in value) {
      return { font: validSize(value.font) ? value.font : 100, components: validSize(value.components) ? value.components : 100 };
    }
  } catch { /* Unavailable storage and invalid data use the current design. */ }
  return { ...defaultAppearance };
}

export function applyAppearance(value: Appearance) {
  const style = document.documentElement.style;
  document.documentElement.dataset.componentSize = String(value.components);
  style.removeProperty("--ui-scale");
  style.setProperty("--ui-component-scale", String(value.components / 100));
  style.setProperty("--ui-font-scale", String(value.font / 100));
}

export function saveAppearance(value: Appearance): boolean {
  applyAppearance(value);
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
    return true;
  } catch { return false; }
}
