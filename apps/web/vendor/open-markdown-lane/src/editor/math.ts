// Dee adaptation: use its existing offline KaTeX assets instead of Vite/MathJax.
import katex from "katex";
export async function renderMath(container: HTMLElement) {
  const macros: Record<string, string> = {};
  for (const target of container.querySelectorAll<HTMLElement>(".mathjax-node")) {
    try {
      katex.render(target.dataset.tex || "", target, {
        displayMode: target.dataset.display === "true", throwOnError: false,
        trust: false, strict: "warn", macros,
      });
      target.dataset.ready = "true";
    } catch (cause) {
      target.textContent = target.dataset.tex || "";
      target.classList.add("math-error");
      target.title = cause instanceof Error ? cause.message : "公式语法错误";
    }
  }
}
