export const fmt = (time: number | null) => time == null ? "—" : new Date(time).toLocaleString();
export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text: string, cls?: string) => {
    const node = document.createElement(tag);
    node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
