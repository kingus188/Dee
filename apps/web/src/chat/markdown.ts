import { escapeHtml } from "../ui/format.js";

// ---- 极简 Markdown 渲染：先整体转义，再加格式，不信任模型输出的任何 HTML ----
function renderInlineMarkdown(text: string) {
    const codes: string[] = [];
    let out = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, c) => {
        codes.push(c);
        return '\u0000' + (codes.length - 1) + '\u0000';
    });
    out = out
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[Number(i)] + '</code>');
}

function renderMarkdown(src: string) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let para: string[] = [];
    const flushPara = () => {
        if (para.length)
            html.push('<p>' + para.map(renderInlineMarkdown).join('<br>') + '</p>');
        para = [];
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fence = line.match(/^\s*```(\S*)\s*$/);
        if (fence) {
            flushPara();
            const body = [];
            for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++)
                body.push(lines[i]);
            html.push('<pre><code>' + escapeHtml(body.join('\n')) + '</code></pre>');
            continue;
        }
        if (!line.trim()) {
            flushPara();
            continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            flushPara();
            const level = Math.min(6, heading[1].length + 2);
            html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
            continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            flushPara();
            html.push('<hr>');
            continue;
        }
        // 表格：| a | b | 下一行是 |---|---|
        if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
            flushPara();
            const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => renderInlineMarkdown(c.trim()));
            const head = cells(line);
            const rows = [];
            for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++)
                rows.push(cells(lines[i]));
            i--;
            html.push('<table><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
                rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
            continue;
        }
        const list = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (list) {
            flushPara();
            const ordered = /\d/.test(list[1]);
            const items = [];
            for (; i < lines.length; i++) {
                const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
                if (!m || /\d/.test(m[1]) !== ordered)
                    break;
                items.push(m[2]);
            }
            i--;
            const tag = ordered ? 'ol' : 'ul';
            html.push(`<${tag}>` + items.map((t) => `<li>${renderInlineMarkdown(t)}</li>`).join('') + `</${tag}>`);
            continue;
        }
        if (/^\s*>\s?/.test(line)) {
            flushPara();
            const quote = [];
            for (; i < lines.length && /^\s*>\s?/.test(lines[i]); i++)
                quote.push(lines[i].replace(/^\s*>\s?/, ''));
            i--;
            html.push('<blockquote>' + quote.map(renderInlineMarkdown).join('<br>') + '</blockquote>');
            continue;
        }
        para.push(line);
    }
    flushPara();
    return html.join('');
}
export { renderMarkdown };
