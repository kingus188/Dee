import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type WechatBotOptions = {
  binary: string; dir: string; origin: string; env: NodeJS.ProcessEnv;
  wechat: { sendURL: string; webhookKey: string; sendToken: string };
  openFile: (path: string) => void; onError: (message: string) => void;
};

// 桌面端把 wx-bot 当子进程管理：无会话先扫码登录，再常驻 run。
export function startWechatBot(options: WechatBotOptions) {
  const { binary, dir, origin, wechat } = options;
  if (!existsSync(binary)) { options.onError(`未找到 wx-bot：${binary}\n请先运行 scripts/build-wx-bot.sh`); return () => {}; }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({
    state_dir: join(dir, "state"), media_dir: join(dir, "media"),
    local_api: { listen: new URL(wechat.sendURL).host, token: "env:WECHAT_SEND_TOKEN" },
    bindings: [{ name: "primary", webhook: { url: `${origin}/channels/wechat/incoming`, key: "env:WECHAT_WEBHOOK_KEY" }, allow_wxids: [] }],
  }), { mode: 0o600 });
  const qrPng = join(dir, "login-qr.png");
  const env = { ...options.env, WECHAT_SEND_TOKEN: wechat.sendToken, WECHAT_WEBHOOK_KEY: wechat.webhookKey, WX_BOT_QR_PNG: qrPng };
  let child: ChildProcess | undefined;
  let stopped = false;

  const run = () => {
    child = spawn(binary, ["--config", config, "run"], { env, stdio: "ignore" });
    child.once("exit", code => { if (!stopped) options.onError(`wx-bot 已退出（code ${code}）。会话过期时请删除 ${join(dir, "state")} 后重启应用重新扫码。`); });
  };
  if (existsSync(join(dir, "state", "primary", "session.json"))) run();
  else {
    child = spawn(binary, ["--config", config, "login", "primary"], { env, stdio: ["ignore", "pipe", "ignore"] });
    let pending = "";
    let shown = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      // 登录进程每出一个新二维码都会先写 PNG，再打印一行 https 链接；按行解析并打开图片，过期换码时再次打开。
      const lines = (pending + chunk.toString()).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const url = /^https:\/\/\S+$/.exec(line.trim())?.[0];
        if (url && url !== shown) { shown = url; options.openFile(qrPng); }
      }
    });
    child.once("exit", code => {
      if (stopped) return;
      if (code === 0) run(); else options.onError("微信扫码登录失败或超时，请重启应用重试。");
    });
  }
  return () => { stopped = true; child?.kill("SIGTERM"); };
}
