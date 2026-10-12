export type CachedElement = HTMLElement & { _lastData?: string; _owner?: string };
export const $ = <T extends HTMLElement = CachedElement>(id: string) => document.getElementById(id) as T;
export const fmt = (time: number | null) => time == null ? "—" : new Date(time).toLocaleString();
export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text: string, cls?: string) => {
    const node = document.createElement(tag);
    node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
export function addButton(target: HTMLElement, label: string, callback: () => void) {
    const button = el("button", label);
    button.type = "button";
    button.addEventListener("click", callback);
    target.append(button);
  }
export function fillEmpty(node: HTMLElement, text: string) {
    if (!node.childElementCount) node.append(el("p", text, "v3-muted"));
  }
