import type { IncomingMessage, ServerResponse } from "node:http";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import type { Conversation, ConversationView } from "@earendil-works/pi-durable";
import type { AppContext } from "../application/context.js";
import type { createViews } from "../application/views.js";
export function createEventStream(context: AppContext, { simplifyView }: ReturnType<typeof createViews>) {
 const { taskGraph, ctx, redact, exitIfFatal } = context;
async function streamEvents(req: IncomingMessage, res: ServerResponse, conversation: Conversation) {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	// 先挂好清理，异步准备期间断开也能释放
	let closed = false;
	let view: AttachedReplicatedState<ConversationView> | null = null;
	let unsubscribe: (() => void) | null = null;
	let unsubscribeGraph: (() => void) | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const ping = setInterval(() => {
		if (res.writableLength === 0) res.write(": ping\n\n");
	}, 15_000);
	const cleanup = () => {
		if (closed) return;
		closed = true;
		clearInterval(ping);
		if (timer) clearTimeout(timer);
		unsubscribe?.();
		unsubscribeGraph?.();
		view?.dispose();
	};
	res.on("close", cleanup);

	// 同一连接同时只推一份；推送期间来的变化合并成下一份最新的。客户端读得慢时等 drain，不堆积旧快照
	let pushing = false;
	let dirty = false;
	const push = async () => {
		timer = null;
		if (closed || !view) return;
		if (pushing) {
			dirty = true;
			return;
		}
		pushing = true;
		try {
			do {
				dirty = false;
				const payload = await simplifyView(conversation.id, view.value);
				if (closed) return;
				if (!res.write(`event: view\ndata: ${JSON.stringify(payload)}\n\n`)) {
					await new Promise((resolve) => res.once("drain", resolve).once("close", resolve));
				}
			} while (dirty && !closed);
		} catch (error) {
			console.error("推送失败：", redact(error instanceof Error ? error.message : error));
			exitIfFatal(error);
		} finally {
			pushing = false;
		}
	};
	const schedule = () => {
		if (!timer && !closed) timer = setTimeout(push, 150);
	};

	view = await conversation.viewState(ctx);
	if (closed) return view.dispose();
	unsubscribe = view.subscribe(schedule);
	unsubscribeGraph = taskGraph.subscribe(schedule);
	await push();
}


return streamEvents;
}
