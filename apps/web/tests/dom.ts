import { JSDOM } from "jsdom";
import { act } from "react";
import type { ReactNode } from "react";
import type { TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";

export async function mount(t: TestContext, component: ReactNode) {
  const dom = new JSDOM('<div id="root"></div><div id="toast-container"></div>', { url: "http://localhost/" });
  const values = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => { root.render(component); });
  t.after(async () => {
    await act(async () => root.unmount());
    // Tiptap delays editor destruction to survive React StrictMode remounts.
    await setTimeout(10);
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { dom, root, render: async (next: ReactNode) => { await act(async () => root.render(next)); } };
}
