import { createRoot } from "react-dom/client";
import { App } from "./ui/App.js";

await Promise.all(Array.from(document.querySelectorAll<HTMLLinkElement>('link[as="style"]'), link => {
  if (link.rel === "stylesheet") return Promise.resolve();
  if (link.dataset.failed) return Promise.reject(new Error("Stylesheet failed to load"));
  return new Promise<void>((resolve, reject) => {
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => reject(new Error("Stylesheet failed to load")), { once: true });
  });
}));
createRoot(document.getElementById("root")!).render(<App />);
