import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tx, ToolExecutionApi } from '@earendil-works/pi-durable';
import { PeerJobs } from '@assistant/runtime';
import { createPersonal, proposeMemoryInTx, editMemoryInTx, decideMemoryInTx, publicMemory, selectMemoryForPrompt } from '@assistant/features';
type Versioned = { id: string; text: string; status: string; revision: number; provenance: { conversationId: number | null; messageId: string | null; quote: string | null }; history: { revision: number; text: string; status: string }[] };
const versioned = (item: unknown) => item as Versioned;
function fixture(entries: object[] = []) {
  const doc = { items: [] as unknown[], applied: {} as Record<string, string> };
  const tx = { doc: async (token: unknown) => token === PeerJobs ? { items: [] } : doc,
    task: async () => ({ kind: 'pi.tool', conversationId: 9, input: { kind: 'model', callId: 'source-1', assistant: 100 } }),
    entry: async () => ({ id: 100, kind: 'pi.assistant', conversationId: 9, model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'source-1' }] }] }),
    conversation: async () => ({}),
    scanEntries: async () => ({ items: entries.map(item => ({ conversationId: 9, ...item })) }) } as unknown as Tx;
  return { doc, tx };
}
test('手动记忆标注出处缺省，并从第一个版本开始', async () => {
  const { doc, tx } = fixture(); const item = versioned(await proposeMemoryInTx(tx, { text: '回答先给结论', source: 'user', approved: true }));
  assert.equal(item.revision, 1); assert.deepEqual(item.provenance, { conversationId: null, messageId: null, quote: null, quoteTruncated: false });
  assert.deepEqual(item.history, []); assert.equal(versioned(publicMemory(doc as never)[0]).revision, 1);
});
test('修改与撤回留版本，历史文本不进入提示', async () => {
  const { doc, tx } = fixture(); const first = await proposeMemoryInTx(tx, { text: '旧偏好', approved: true });
  const edited = versioned(await editMemoryInTx(tx, first.id, '新偏好', first));
  assert.equal(edited.revision, 2); assert.equal(edited.history[0].text, '旧偏好'); assert.equal(edited.history[0].revision, 1);
  assert.deepEqual(selectMemoryForPrompt(doc.items as never).map(item => item.text), ['新偏好']);
  const revoked = versioned(await decideMemoryInTx(tx, first.id, 'reject')); assert.equal(revoked.revision, 3); assert.equal(revoked.history[1].status, 'approved');
});
test('记忆改回原文仍拒绝旧版本覆盖', async () => {
  const { tx } = fixture(); const first = await proposeMemoryInTx(tx, { text: '甲', approved: true });
  await editMemoryInTx(tx, first.id, '乙'); await editMemoryInTx(tx, first.id, '甲');
  await assert.rejects(editMemoryInTx(tx, first.id, '丙', { ...first, revision: 1 }), /记忆已更新/);
});
async function propose(entries: object[]) {
  const { doc, tx } = fixture(entries); const extension = createPersonal({});
  const tool = extension.tools!.find(tool => tool.name === 'propose_memory')!;
  const api = { taskId: 1, callId: 'source-1', conversationId: 9, commit: async (work: (tx: Tx) => unknown) => work(tx) } as unknown as ToolExecutionApi;
  await tool.execute({ text: '回答要简洁' }, api, {} as never);
  return versioned(doc.items[0]);
}
test('工具记忆保留真实用户条目和原文', async () => {
  const item = await propose([{ id: 80, kind: 'pi.assistant' }, { id: 77, kind: 'pi.user', model: [{ role: 'user', content: '希望回答简洁' }] }]);
  assert.equal(item.status, 'pending'); assert.equal(item.provenance.messageId, '77'); assert.equal(item.provenance.conversationId, 9); assert.equal(item.provenance.quote, '希望回答简洁');
});
test('定时派生输入不借用旧用户消息作出处', async () => {
  const item = await propose([{ id: 90, kind: 'app.schedule-input', model: [{ role: 'user', content: '[计划任务] 复盘' }] }, { id: 77, kind: 'pi.user', model: [{ role: 'user', content: '旧消息' }] }]);
  assert.equal(item.provenance.messageId, null); assert.equal(item.provenance.quote, null);
});
test('旧数据保留原文且不伪造消息出处', () => {
  const old = { id: 'legacy', text: '原偏好', status: 'approved', source: 'agent', conversationId: 9, createdAt: 1, decidedAt: 2 };
  const item = versioned(publicMemory({ items: [old] } as never)[0]);
  assert.equal(item.text, '原偏好'); assert.equal(item.revision, 1); assert.equal(item.provenance.messageId, null); assert.deepEqual(item.history, []);
});

test('当前记忆清单显示修订并在全部撤回后显式失效旧上下文', async () => {
  const { doc, tx } = fixture();
  const extension = createPersonal({});
  const section = extension.sections!.find(section => section.key === 'memory')!;
  const input = { read: { snapshot: async () => doc } };
  const render = () => section.render(input as never, {} as never);
  const first = await proposeMemoryInTx(tx, { text: '旧偏好', approved: true });
  assert.match(String(await render()), new RegExp(`${first.id}@1`));
  await editMemoryInTx(tx, first.id, '新偏好');
  const updated = String(await render());
  assert.match(updated, new RegExp(`${first.id}@2`));
  assert.doesNotMatch(updated, /旧偏好/);
  await decideMemoryInTx(tx, first.id, 'reject');
  const empty = String(await render());
  assert.match(empty, /当前没有已批准/);
  assert.match(empty, /取代历史上下文和摘要中的旧清单/);
  assert.doesNotMatch(empty, /新偏好/);
});

test('按版本渐进读取记忆来源，不泄露已撤回或旧版本正文', async () => {
  const { tx } = fixture();
  const first = await proposeMemoryInTx(tx, { text: '旧偏好', approved: true,
    provenance: { conversationId: 9 as never, messageId: '77', quote: '原消息', quoteTruncated: true } });
  const tool = createPersonal({}).tools!.find(tool => tool.name === 'read_memory')!;
  const api = { commit: async (work: (tx: Tx) => unknown) => work(tx) } as unknown as ToolExecutionApi;
  const read = async (revision: number) => JSON.stringify(await tool.execute({ id: first.id, revision }, api, {} as never));
  assert.doesNotMatch(await read(1), /原消息/);
  assert.match(await read(1), /explicit_read/);
  assert.match(await read(1), /quoteTruncated/);
  await editMemoryInTx(tx, first.id, '新偏好');
  assert.doesNotMatch(await read(1), /旧偏好|新偏好|原消息/);
  assert.match(await read(2), /新偏好/);
  await decideMemoryInTx(tx, first.id, 'reject');
  assert.doesNotMatch(await read(2), /旧偏好|新偏好|原消息/);
  assert.doesNotMatch(await read(3), /旧偏好|新偏好|原消息/);
});

test('未知宿主输入和跨节点结果不借用历史用户出处', async () => {
  for (const kind of ['app.peer-input', 'app.peer-result', 'app.future-input']) {
    const item = await propose([{ id: 90, kind, model: [{ role: 'user', content: '派生任务' }] },
      { id: 77, kind: 'pi.user', model: [{ role: 'user', content: '旧用户消息' }] }]);
    assert.equal(item.provenance.messageId, null, kind);
    assert.equal(item.provenance.quote, null, kind);
  }
});

test('记忆保存与本轮上下文分离，目录曝光和显式读取不改变用户批准', async () => {
  const { tx, doc } = fixture();
  for (let n = 0; n < 30; n++) await proposeMemoryInTx(tx, { text: `${n}:` + '记'.repeat(270), approved: true, source: 'user' });
  await assert.rejects(proposeMemoryInTx(tx, { text: '第31条', approved: true }), /已确认记忆已满/);
  const before = JSON.stringify(doc), extension = createPersonal({});
  const rendered = String(await extension.sections!.find(section => section.key === 'memory')!.render({ read: { snapshot: async () => doc } } as never, {} as never));
  assert.ok(rendered.length <= 1800);
  assert.match(rendered, /未展示不代表未保存或已撤回/);
  assert.match(rendered, /模型自报不等于用户确认/);
  assert.doesNotMatch(rendered, /\[.*?@1\] 0:/);
  const api = { commit: async (work: (tx: Tx) => unknown) => work(tx) } as unknown as ToolExecutionApi;
  const listed = JSON.stringify(await extension.tools!.find(tool => tool.name === 'list_memories')!.execute({}, api, {} as never));
  assert.match(listed, /candidate_index/); assert.match(listed, /previewTruncated/);
  const first = versioned(doc.items[0]);
  assert.ok(listed.includes(first.id));
  const read = JSON.stringify(await extension.tools!.find(tool => tool.name === 'read_memory')!.execute({ id: first.id, revision: 1 }, api, {} as never));
  assert.match(read, /explicit_read/); assert.match(read, /unverified_tool_origin/); assert.ok(read.includes(first.text));
  assert.equal(JSON.stringify(doc), before);
});

test('延迟记忆工具绑定原assistant锚，不借后来用户消息作为出处', async () => {
  const item = await propose([{ id: 120, kind: 'pi.user', model: [{ role: 'user', content: '后来用户消息' }] },
    { id: 77, kind: 'pi.user', model: [{ role: 'user', content: '原始偏好' }] }]);
  assert.equal(item.provenance.messageId, '77'); assert.equal(item.provenance.quote, '原始偏好');
});

test('出处缺失明确未知，但存储读取错误不得伪装为无出处', async () => {
  const { memoryProvenanceInTx } = await import('@assistant/features');
  const origin = { taskId: 1, callId: 'source-1', conversationId: 9 } as Parameters<typeof memoryProvenanceInTx>[1];
  const { tx } = fixture();
  assert.equal((await memoryProvenanceInTx({ ...tx, task: async () => undefined } as Tx, origin)).messageId, null);
  await assert.rejects(memoryProvenanceInTx({ ...tx, task: async () => { throw new Error('database unavailable'); } } as Tx, origin), /database unavailable/);
});

test('真实SDK持久tool锚在后来用户turn后仍定位原出处，派生输入仍无用户出处', { timeout: 15000 }, async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context');
  const { createModelCatalog, openRuntime } = await import('@assistant/runtime');
  const { fauxAssistantMessage, fauxToolCall } = await import('@earendil-works/pi-ai/providers/faux');
  const { memoryProvenanceInTx } = await import('@assistant/features');
  const dataDir = await mkdtemp(join(tmpdir(), 'dee-memory-origin-'));
  const extension = createPersonal({}), origins: Parameters<typeof memoryProvenanceInTx>[1][] = [];
  const tools = extension.tools!.map(tool => tool.name !== 'propose_memory' ? tool : { ...tool,
    execute: async (args: unknown, api: ToolExecutionApi, callContext: Parameters<typeof tool.execute>[2]) => {
      origins.push({ taskId: api.taskId, callId: api.callId, conversationId: api.conversationId });
      return tool.execute(args, api, callContext);
    } });
  const catalog = await createModelCatalog({ api: 'faux', apiKey: '', baseUrl: '', model: '', contextWindow: 128000, maxTokens: 8192 }, transcript => {
    const last = transcript.messages.at(-1);
    return last?.role === 'user' && typeof last.content === 'string' && last.content.includes('偏好')
      ? fauxAssistantMessage(fauxToolCall('propose_memory', { text: '简洁回答' }), { stopReason: 'toolUse' }) : fauxAssistantMessage('done');
  });
  const runtime = await openRuntime({ dataDir, ...catalog, extensions: [{ ...extension, tools }], onReport: () => {} }, context);
  try {
    const conversation = await runtime.harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: catalog.agentModel } }, context);
    await (await conversation.submit({ type: 'input', content: '我的偏好是简洁回答' }, context)).wait(context);
    const before = await conversation.commit(tx => memoryProvenanceInTx(tx, origins[0]), context);
    await (await conversation.submit({ type: 'input', content: '这是后来无关消息' }, context)).wait(context);
    const delayed = await conversation.commit(tx => memoryProvenanceInTx(tx, origins[0]), context);
    assert.deepEqual(delayed, before); assert.equal(delayed.quote, '我的偏好是简洁回答');
    for (const content of ['[Teams 通知] 偏好', '<引用>偏好</引用>']) {
      await (await conversation.submit({ type: 'input', content }, context)).wait(context);
      assert.equal((await conversation.commit(tx => memoryProvenanceInTx(tx, origins.at(-1)!), context)).messageId, null);
    }
  } finally { await runtime.harness.close(context); await rm(dataDir, { recursive: true, force: true }); }
});
