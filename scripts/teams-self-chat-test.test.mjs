import test from 'node:test';
import assert from 'node:assert/strict';
import { testSelfChat, REPLY_PREFIX } from './teams-self-chat-test.mjs';

function fixture() {
  let time = 1000, reads = 0, sends = 0, calls = 0;
  const message = { id: 'input', from: { user: { id: 'me' } }, messageType: 'message', createdDateTime: new Date(1100).toISOString(), text: '请帮我整理工作' };
  const me = { id: 'me', userPrincipalName: 'haifeng.zhang@example.com' };
  const chat = { id: '19:me_me@unq.gbl.spaces', chatType: 'oneOnOne', members: [{ userId: 'me' }] };
  let receipt;
  const options = {
    username: 'haifeng.zhang', chatId: chat.id, signal: new AbortController().signal, now: () => time,
    wait: async () => { time += 60_000; },
    generate: async () => { calls++; return '可以先列出待处理消息。'; },
    graph: async (path, body) => {
      if (path === '/me') return me;
      if (path.startsWith('/me/chats')) return { value: [chat] };
      assert.ok(path.startsWith(`/chats/${encodeURIComponent(chat.id)}/messages`));
      if (body) { sends++; receipt = { id: 'reply', text: body.body.content }; return receipt; }
      if (path.endsWith('/input')) return message;
      if (path.endsWith('/reply')) return receipt;
      reads++;
      return { value: reads === 1 ? [{ ...message, id: 'old' }] : [message, { ...message, id: 'echo', text: REPLY_PREFIX + '旧回复' }] };
    },
  };
  return { options, me, chat, message, get sends() { return sends; }, get calls() { return calls; } };
}

test('answers fresh self-chat input once, verifies delivery and excludes history and AI echoes', async () => {
  const f = fixture();
  assert.equal((await testSelfChat(f.options)).replies, 1);
  assert.equal(f.sends, 1);
  assert.equal(f.calls, 1);
});

test('wrong account, another member, group or ambiguous self-chat never generate or send', async () => {
  for (const change of [f => { f.me.userPrincipalName = 'other@example.com'; }, f => { f.chat.members.push({ userId: 'other' }); }, f => { f.chat.chatType = 'group'; }, f => { f.chat.id = 'former-private-chat'; }]) {
    const f = fixture(); change(f);
    await assert.rejects(testSelfChat(f.options));
    assert.equal(f.sends, 0); assert.equal(f.calls, 0);
  }
});

test('native self-chat uses 48:notes without listing ordinary chats', async () => {
  const f = fixture(), graph = f.options.graph;
  f.options.chatId = '48:notes';
  f.options.graph = async (path, body) => {
    assert.ok(!path.startsWith('/me/chats'));
    const result = await graph(path.replace('48%3Anotes', encodeURIComponent(f.chat.id)), body);
    return result.value ? { ...result, value: result.value.map(m => ({ ...m, chatId: '48:notes' })) } : result;
  };
  assert.equal((await testSelfChat(f.options)).replies, 1);
  assert.equal(f.sends, 1); assert.equal(f.calls, 1);
});

test('native self-chat rejects mismatched history before generating or sending', async () => {
  for (const mismatch of [{ chatId: 'other' }, { from: { user: { id: 'other' } } }]) {
    const f = fixture(), graph = f.options.graph;
    f.options.chatId = '48:notes';
    f.options.graph = async (path, body) => {
      assert.ok(!path.startsWith('/me/chats'));
      const result = await graph(path.replace('48%3Anotes', encodeURIComponent(f.chat.id)), body);
      return result.value ? { ...result, value: result.value.map(m => ({ ...m, chatId: '48:notes', ...mismatch })) } : result;
    };
    await assert.rejects(testSelfChat(f.options), /自聊历史/);
    assert.equal(f.sends, 0); assert.equal(f.calls, 0);
  }
});

test('unknown send result stops after one attempt', async () => {
  const f = fixture(), graph = f.options.graph;
  let attempts = 0;
  f.options.graph = async (path, body) => { if (body) { attempts++; throw new Error('timeout'); } return graph(path, body); };
  await assert.rejects(testSelfChat(f.options), /timeout/);
  assert.equal(attempts, 1);
});

test('multiple self-member chats require an explicit target', async () => {
  const f = fixture(), graph = f.options.graph;
  delete f.options.chatId;
  f.options.graph = async (path, body) => path.startsWith('/me/chats') ? { value: [f.chat, { ...f.chat, id: 'old-private' }] } : graph(path, body);
  await assert.rejects(testSelfChat(f.options), /无法唯一确认/);
  assert.equal(f.calls, 0); assert.equal(f.sends, 0);
});

test('edited source, empty generation and model failure do not send', async () => {
  for (const mode of ['edited', 'empty', 'error']) {
    const f = fixture();
    f.options.generate = async () => {
      if (mode === 'edited') f.message.text = 'edited';
      if (mode === 'error') throw new Error('model failed');
      return mode === 'empty' ? '' : 'answer';
    };
    await assert.rejects(testSelfChat(f.options)); assert.equal(f.sends, 0);
  }
});

test('invalid timestamps and other senders never trigger generation', async () => {
  for (const change of [f => { f.message.createdDateTime = 'invalid'; }, f => { f.message.from.user.id = 'other'; }]) {
    const f = fixture(); change(f);
    assert.equal((await testSelfChat(f.options)).replies, 0); assert.equal(f.calls, 0);
  }
});
