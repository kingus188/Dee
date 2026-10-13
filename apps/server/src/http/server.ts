import { createServer } from "node:http";
import type { AppContext } from "../application/context.js";
import { HttpError } from "../errors.js";
import { authorized, secureMatch } from "./auth.js";
import { readBody, sendJson } from "./io.js";
import { createRouter } from "./router.js";
import { createApi } from "../application/api.js";
import { attachWebSocket } from "./socket.js";
export function createHttpServer(context: AppContext, webRoot: URL) {
 const { wechat, config, redact, exitIfFatal } = context;
 const api = createApi(context);
 const route = createRouter(context, webRoot, api);
 const server = createServer(async (req, res) => {
  // 微信 webhook 独立令牌；绝不绕过普通网页/API 的 Basic Auth。
  if (req.method === "POST" && req.url?.split("?")[0] === "/channels/wechat/incoming") {
    const bearer = req.headers.authorization || "";
    if (!wechat || !secureMatch(bearer, "Bearer " + config.wechat.webhookKey)) {
      return sendJson(res, 401, { error: "微信通道未启用或令牌不正确" });
    }
    try {
      const result = await wechat.incoming(await readBody(req));
      return sendJson(res, 202, result);
    } catch (error) {
      const isInputError = error instanceof Error && /不合法|空消息|长度限制|消息体必须|超出长度/.test(error?.message || "");
      if (!isInputError) console.error("微信入站处理失败：", redact(error instanceof Error ? error.message : error));
      exitIfFatal(error);
      return sendJson(res, isInputError ? 400 : 503, { error: isInputError ? error.message : "微信消息暂未接收，请重试" });
    }
  }
	if (!authorized(req, config.password)) {
		res.writeHead(401, { "www-authenticate": 'Basic realm="pi-durable-assistant", charset="UTF-8"' });
		return res.end("需要口令");
	}
	try {
		await route(req, res);
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 500;
		if (status === 500) console.error("请求出错：", redact(error instanceof Error ? error.stack : error));
		if (!res.headersSent) sendJson(res, status, { error: error instanceof HttpError && status !== 500 ? error.message : "服务器出错，详情见服务器日志" });
		else res.end();
		exitIfFatal(error);
	}
});
 return Object.assign(server, { closeSockets: attachWebSocket(server, context, api) });
}
