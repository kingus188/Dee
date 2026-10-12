import type { Context, AttachedReplicatedState } from "@earendil-works/chord";
import type { TaskGraph } from "@earendil-works/pi-durable";
import type { Runtime } from "@assistant/runtime";
import type { createTaskCenter } from "@assistant/features";
import type { WechatChannel } from "@assistant/channel-wechat";
import type { AppConfig } from "../config.js";
export type AppContext = Runtime & {
  config: AppConfig; ctx: Context; taskGraph: AttachedReplicatedState<TaskGraph>;
  tasks: ReturnType<typeof createTaskCenter>; wechat: WechatChannel | null;
  modelLabel: string; startedAt: string; redact: (value: unknown) => string; exitIfFatal: (error: unknown) => void;
};
