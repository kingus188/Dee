import { createElement, memo, useMemo, type ReactNode } from "react";
import MarkdownIt, { type Token } from "markdown-it";
import { CodeBlock } from "./CodeBlock.js";

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true }).disable(["image"]);
markdown.validateLink = url => /^https?:\/\//i.test(url);
const Inline = memo(function Inline({ html }: { html: string }) {
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
});

/** Stable component positions keep completed code blocks mounted as streaming text grows. */
export const MarkdownContent = memo(function MarkdownContent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const tokens = useMemo(() => markdown.parse(text, {}), [text]);
  const lastContentIndex = tokens.findLastIndex(token => token.nesting !== -1);
  let cursor = 0;
  function children(): ReactNode[] {
    const nodes: ReactNode[] = [];
    while (cursor < tokens.length) {
      const index = cursor++, token: Token = tokens[index];
      if (token.nesting === -1) break;
      if (token.type === "fence" || token.type === "code_block") {
        const source = token.content.replace(/\n$/, "");
        const language = token.info.trim().split(/\s+/)[0] || "text";
        nodes.push(<CodeBlock key={index} source={source} language={language} streaming={streaming && index === lastContentIndex} />);
      } else if (token.type === "inline") {
        const inline = (token.children ?? []).map(child => child.type === "link_open"
          ? { ...child, attrs: [...(child.attrs ?? []), ["target", "_blank"], ["rel", "noopener noreferrer"]] as [string, string][] }
          : child);
        nodes.push(<Inline key={index} html={markdown.renderer.renderInline(inline, markdown.options, {})} />);
      } else if (token.nesting === 1) {
        const inner = children();
        const tag = /^h[1-6]$/.test(token.tag) ? `h${Math.min(6, Number(token.tag[1]) + 2)}` : token.tag;
        const props: Record<string, unknown> = { key: index };
        // Attributes are produced by MarkdownIt, never copied from model-authored HTML.
        for (const [name, value] of token.attrs ?? []) {
          if (name === "start") props.start = Number(value);
          if (name === "style") props.style = { textAlign: value.replace("text-align:", "") };
        }
        nodes.push(token.hidden ? <span key={index}>{inner}</span> : createElement(tag, props, inner));
      } else if (token.tag === "hr") nodes.push(<hr key={index} />);
    }
    return nodes;
  }
  return <>{children()}</>;
});
