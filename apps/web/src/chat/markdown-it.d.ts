declare module "markdown-it" {
  export interface Token {
    type: string; tag: string; nesting: number; content: string; info: string;
    hidden: boolean; attrs: [string, string][] | null; children: Token[] | null;
    map: [number, number] | null;
  }
  export default class MarkdownIt {
    constructor(options: { html: boolean; breaks: boolean; linkify: boolean });
    validateLink: (url: string) => boolean;
    disable(names: string[]): this;
    parse(source: string, env: object): Token[];
    renderer: { renderInline(tokens: Token[], options: object, env: object): string };
    options: object;
  }
}
