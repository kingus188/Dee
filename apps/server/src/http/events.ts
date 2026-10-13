import type { IncomingMessage, ServerResponse } from "node:http";
import type { Conversation } from "@earendil-works/pi-durable";
import type { AppContext } from "../application/context.js";
import type { createViews } from "../application/views.js";
import { watchView } from "../application/view-stream.js";

export function createEventStream(context: AppContext, views: ReturnType<typeof createViews>) {
  return async (_req: IncomingMessage, res: ServerResponse, conversation: Conversation) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const stream = watchView(context, views, conversation, async payload => {
      if (!res.write(`event: view\ndata: ${JSON.stringify(payload)}\n\n`)) await new Promise<void>(resolve => {
        const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
        res.once("drain", done); res.once("close", done);
      });
    }, error => {
      console.error("推送失败：", context.redact(error instanceof Error ? error.message : error));
      context.exitIfFatal(error); res.end();
    });
    const ping = setInterval(() => { if (!res.writableLength) res.write(": ping\n\n"); }, 15_000);
    res.once("close", () => { clearInterval(ping); stream.close(); });
    await stream.ready;
  };
}
