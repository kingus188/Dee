import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

export type PeerToolHandler = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export type PeerMcp = { command: string; args: string[]; env: Record<string, string> };
const session = { agent: { type: "string", enum: ["pi", "codex", "claude", "acp"] }, sessionId: { type: "string" } };
const tools = [
  { name: "peer_sessions", description: "List existing Agent sessions on this node or server. Remote desktop history is a synchronized snapshot.", inputSchema: { type: "object", properties: { node: { type: "string" } } } },
  { name: "read_peer_session", description: "Read a specific Agent session without switching or running it.", inputSchema: { type: "object", properties: { node: { type: "string" }, ...session }, required: ["node", "agent", "sessionId"] } },
  { name: "send_to_peer_session", description: "Queue work in the specified existing Agent session. Desktop execution requires user approval. Keep requestId unchanged when retrying; inspect peer_task_status for results before relaying.", inputSchema: { type: "object", properties: { target: { type: "string" }, ...session, task: { type: "string", maxLength: 16000 }, requestId: { type: "string", format: "uuid" } }, required: ["target", "agent", "sessionId", "task", "requestId"] } },
  { name: "peer_task_status", description: "Read the durable task status and result; never replay an interrupted native operation automatically.", inputSchema: { type: "object", properties: { id: { type: "string", format: "uuid" } }, required: ["id"] } },
];

// This stdio adapter only carries MCP calls to the existing in-process peer queue.
const adapter = `const {createInterface}=require('node:readline');
createInterface({input:process.stdin}).on('line',async line=>{let m;try{m=JSON.parse(line);const r=await fetch(process.env.DEE_PEER_MCP_URL,{method:'POST',headers:{authorization:'Bearer '+process.env.DEE_PEER_MCP_TOKEN,'content-type':'application/json'},body:JSON.stringify(m),signal:AbortSignal.timeout(30000)});if(m.id!==undefined){if(!r.ok)throw Error();process.stdout.write(JSON.stringify(await r.json())+'\\n');}}catch{if(m?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'Peer tools unavailable; inspect original request before retrying'}})+'\\n');}});`;

export async function openPeerTools(call: PeerToolHandler): Promise<{ config: PeerMcp; close(): Promise<void> }> {
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.headers.authorization !== `Bearer ${token}` || request.headers.origin) { response.writeHead(403).end(); return; }
    let id: unknown;
    try {
      let body = "";
      for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 64000) { response.writeHead(413).end(); return; } }
      const message = JSON.parse(body) as { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown; protocolVersion?: unknown } };
      id = message.id;
      if (id === undefined) { response.writeHead(202).end(); return; }
      let result: unknown;
      if (message.method === "initialize") result = { protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "dee-peers", version: "1" } };
      else if (message.method === "ping") result = {};
      else if (message.method === "tools/list") result = { tools };
      else if (message.method === "tools/call") {
        const name = message.params?.name, args = message.params?.arguments;
        if (typeof name !== "string" || !tools.some(tool => tool.name === name) || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid peer tool");
        result = { content: [{ type: "text", text: JSON.stringify(await call(name, args as Record<string, unknown>)) }] };
      } else { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown MCP method" } })); return; }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message: "Peer operation failed; inspect its original requestId before retrying" } }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  server.unref();
  const config = { command: process.execPath, args: ["-e", adapter], env: { ELECTRON_RUN_AS_NODE: "1", DEE_PEER_MCP_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, DEE_PEER_MCP_TOKEN: token } };
  return { config, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
