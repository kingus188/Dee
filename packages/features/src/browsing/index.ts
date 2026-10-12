import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { fetchPublicPage } from "./net.js";
import { resultText as text } from "../results.js";
function htmlToText(html: string) {
	return html
		.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

export const fetchPage = defineTool({
	name: "fetch_page",
	description: "抓取一个公开网页的正文文字（最多 6000 字）",
	parameters: Type.Object({ url: Type.String({ description: "http 或 https 地址" }) }),
	replay: "safe",
	execute: async (args, _api, callContext) => {
		const page = await fetchPublicPage(args.url, callContext.abortSignal);
		return text(`HTTP ${page.status}\n${htmlToText(page.text).slice(0, 6000)}`);
	},
});
