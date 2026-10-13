import type { ServerInfo } from "@assistant/contracts";
export async function readServerInfo(): Promise<ServerInfo> {
        const res = await fetch('/api/info');
        if (!res.ok)
            throw new Error('拉取服务信息失败');
        return await res.json();

}
