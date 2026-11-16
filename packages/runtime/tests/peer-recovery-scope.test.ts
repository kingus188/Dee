import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createModelCatalog, createPeerService, openRuntime, PeerJobs } from "@assistant/runtime";

const model = { api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 };
for (const change of ["revoked", "cap", "resource", "ancestor_cancel", "source_revoked"] as const) test(`safe execute checkpoint recovery rechecks ${change} without invoking the tool`, { timeout: 15000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-peer-execute-crash-"));
  const id = randomUUID();
  // A real process death leaves the SDK's committed execute checkpoint intact,
  // unlike graceful abort, which can settle the task before restart.
  const script = `
    import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
    import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
    import { Type } from '@earendil-works/pi-ai';
    import { defineExtension, defineTool } from '@earendil-works/pi-durable';
    import { createModelCatalog, createPeerService, openRuntime } from '@assistant/runtime';
    const catalog = await createModelCatalog(${JSON.stringify(model)}, t => t.messages.at(-1)?.role === 'toolResult' ? fauxAssistantMessage('done') : fauxAssistantMessage(fauxToolCall(${JSON.stringify(change === 'ancestor_cancel')} ? (t.messages.at(-1)?.content === 'child' ? 'nested_read' : 'local_delegate') : 'read_record', {}), {stopReason:'toolUse'}));
    const business = defineExtension({name:'business',tools:[
      defineTool({name:'local_delegate',description:'legacy child',parameters:Type.Object({}),replay:'safe',execute:async (_args,api,context)=>{
        const child=await api.commit(tx=>tx.createConversation({ownership:{kind:'task',taskId:api.taskId}}),context);
        const handle=await api.conversation(child.id,context);
        await (await handle.submit({type:'input',content:'child',requestId:'delegate:'+api.taskId},context)).wait(context);
        return {output:[]};
      }}),
      defineTool({name:'nested_read',description:'nested',parameters:Type.Object({}),replay:'safe',execute:async (_args,api,context)=>{await api.executeTool('read_record',{},context);return {output:[]};}}),
      defineTool({name:'read_record',description:'read',parameters:Type.Object({}),replay:'safe',execute:async (_args,api,context)=>{
      const task = await api.commit(tx=>tx.task(api.taskId),context);
      console.log(JSON.stringify({phase:task.state.checkpoint.phase,conversationId:api.conversationId,taskId:api.taskId,callId:api.callId}));
      await new Promise(()=>{});
      return {output:[]};
    }})]});
    const peers=createPeerService({nodeId:'server',configured:()=>true,readPolicy:{revision:'v1',tools:['read_record','local_delegate','nested_read'],resourceRoot:'/approved'}});
    const runtime=await openRuntime({dataDir:${JSON.stringify(dataDir)},...catalog,extensions:[peers.extension,peers.accessExtension,business],beforeToolExecute:peers.guardTool,beforeResume:r=>peers.bind(r,ctx),onReport:()=>{}},ctx);
    const job=await peers.submit({id:${JSON.stringify(id)},source:'desktop-${randomUUID()}',target:'server',task:'read record'});
    setInterval(()=>{},1000); void peers.run(job.id);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
  let crashedConversation = 0, crashedTask = 0, crashedCall = "";
  let stderr = ""; child.stderr.on("data", value => { stderr += String(value); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", value => { output += String(value); if (output.includes('"phase":"execute"')) { const record = JSON.parse(output.trim().split('\n').at(-1)!); crashedConversation = record.conversationId; crashedTask = record.taskId; crashedCall = record.callId; resolve(); } });
      child.on("exit", code => reject(new Error(`fixture exited ${code}: ${stderr}`)));
    });
    child.kill("SIGKILL"); await new Promise<void>(resolve => child.once("exit", () => resolve()));
    let executions = 0;
    const catalog = await createModelCatalog(model, transcript => transcript.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage("done") : fauxAssistantMessage(fauxToolCall("read_record", {}), { stopReason: "toolUse" }));
    const business = defineExtension({ name: "business", tools: [
      defineTool({ name: "local_delegate", description: "legacy child", parameters: Type.Object({}), replay: "safe", execute: async () => { executions++; return { output: [] }; } }),
      defineTool({ name: "nested_read", description: "nested", parameters: Type.Object({}), replay: "safe", execute: async (_args, api, context) => { executions++; await api.executeTool("read_record", {}, context); return { output: [] }; } }),
      defineTool({ name: "read_record", description: "read", parameters: Type.Object({}), replay: "safe", execute: async () => { executions++; return { output: [{ type: "text", text: "unexpected read" }] }; } })] });
    const policy = { revision: "v1", tools: change === "cap" ? [] : ["read_record", "local_delegate", "nested_read"], resourceRoot: change === "resource" ? "/different" : "/approved" };
    const peers = createPeerService({ nodeId: "server", configured: () => true, readPolicy: policy, verifySource: change === "source_revoked" ? async () => false : undefined });
    const runtime = await openRuntime({ dataDir, ...catalog, resume: change !== "ancestor_cancel", extensions: [peers.extension, peers.accessExtension, business], beforeToolExecute: peers.guardTool, onReport: () => {}, beforeResume: async value => {
      peers.bind(value, ctx);
      if (change === "ancestor_cancel") await value.root.commit(async tx => { (await tx.doc(PeerJobs)).items.find(job => job.id === id)!.cancellation = { requestedAt: new Date().toISOString() }; }, ctx);
      if (change === "revoked") await value.root.commit(async tx => { const scope = (await tx.doc(PeerJobs)).items.find(job => job.id === id)!.readScope!; scope.revoked = true; scope.revision++; }, ctx);
    } }, ctx);
    try {
      if (change === "ancestor_cancel") {
        // Exercise the guard with the actual persisted nested execute task
        // before the SDK resumes its owner and cascades cancellation.
        await assert.rejects(peers.guardTool("read_record", {}, { taskId: crashedTask, callId: crashedCall, conversationId: crashedConversation } as import("@earendil-works/pi-durable").ToolExecutionApi, ctx), /范围已撤销|有效只读权限/);
      }
      const job = (await peers.get(id))!;
      const conversation = (await runtime.harness.conversation(crashedConversation as typeof runtime.root.id, ctx))!;
      const owner = await runtime.root.commit(tx => tx.conversation(conversation.id), ctx);
      const requestId = change === "ancestor_cancel" ? `delegate:${owner!.owner!.taskId}` : `peer:${id}`;
      const submission = await conversation.submit({ type: "input", content: "unused dedup content", requestId }, ctx);
      await submission.wait(ctx);
      assert.equal(executions, 0);
      const context = await conversation.context(ctx);
      assert.match(JSON.stringify(context.entries), change === "ancestor_cancel" ? /范围已撤销|有效只读权限|was aborted/ : /范围已撤销|有效只读权限|源宿主授权/);
    } finally { await peers.close(); await runtime.harness.close(ctx); }
  } finally { child.kill("SIGKILL"); await rm(dataDir, { recursive: true, force: true }); }
});

test("an extension replacing execute cannot erase the host execution guard", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-tool-wrapper-"));
  let executions = 0, checks = 0;
  const catalog = await createModelCatalog(model, transcript => transcript.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage("done") : fauxAssistantMessage(fauxToolCall("write_record", {}), { stopReason: "toolUse" }));
  const tool = defineTool({ name: "write_record", description: "write", parameters: Type.Object({}), replay: "safe", execute: async () => ({ output: [] }) });
  const business = defineExtension({ name: "business", tools: [tool] });
  const replacement = defineExtension({ name: "replacement", wraps: [{ tool: "write_record", wrap: (value: import("@earendil-works/pi-durable").ToolRegistration) => ({ ...value, execute: async () => { executions++; return { output: [] }; } }) }] });
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [business, replacement], beforeToolExecute: async () => { checks++; throw new Error("denied by host"); }, onReport: () => {} }, ctx);
  try { await (await runtime.root.submit({ type: "input", content: "attempt write" }, ctx)).wait(ctx); assert.equal(executions, 0); assert.equal(checks, 1); }
  finally { await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});
