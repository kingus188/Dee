import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const REPLY_PREFIX = '[Dee AI 测试回复] ';

// A fresh baseline on each run excludes history and uncertain sends from replay.
export async function testSelfChat({ graph, generate, username, chatId: targetChatId, signal, seed, wait = delay, now = Date.now }) {
  const me = await graph('/me');
  if (!me.id || me.userPrincipalName?.split('@')[0].toLowerCase() !== username.toLowerCase()) throw new Error('当前 Teams 账号与指定测试账号不一致');
  let chatId = targetChatId;
  // Teams' native self-chat is account-scoped and absent from /me/chats.
  if (chatId !== '48:notes') {
    const chats = [];
    let next = '/me/chats?$expand=members&$top=50';
    const pages = new Set();
    while (next) {
      if (pages.has(next) || pages.size >= 100) throw new Error('Teams 会话分页未完成');
      pages.add(next);
      const page = await graph(next);
      if (!Array.isArray(page.value)) throw new Error('Teams 会话响应无效');
      chats.push(...page.value);
      next = page['@odata.nextLink'];
    }
    // Old private chats can retain only our membership after the peer leaves.
    const candidates = chats.filter(c => (!targetChatId || c.id === targetChatId) && c.chatType === 'oneOnOne' && c.members?.length === 1 && c.members[0].userId === me.id);
    if (candidates.length !== 1 || !candidates[0].id) {
      console.error(JSON.stringify({ selfChatCandidates: candidates.length, chats: chats.length }));
      throw new Error('无法唯一确认与自己聊天，未发送');
    }
    chatId = candidates[0].id;
  }
  const path = `/chats/${encodeURIComponent(chatId)}/messages`;
  const read = async () => {
    const result = await graph(`${path}?$top=50&$orderby=createdDateTime desc`);
    if (!Array.isArray(result.value)) throw new Error('Teams 消息响应无效');
    return result.value;
  };
  const baseline = await read();
  if (chatId === '48:notes' && baseline.some(m => m.chatId !== chatId || (m.from?.user && m.from.user.id !== me.id))) throw new Error('自聊历史与当前账号或目标不一致，未发送');
  const seen = new Set(baseline.map(m => m.id));
  const started = now();
  if (seed) await graph(path, { body: { contentType: 'text', content: seed } });
  let replies = 0;
  while (!signal.aborted && now() - started < 120_000 && replies < 3) {
    const messages = await read();
    if (messages.length === 50 && messages.every(m => !seen.has(m.id))) throw new Error('测试消息超过单页，已停止以免遗漏');
    for (const message of [...messages].reverse()) {
      if (!message.id || seen.has(message.id)) continue;
      seen.add(message.id);
      if (message.from?.user?.id !== me.id || message.messageType !== 'message' || message.deletedDateTime || !Number.isFinite(Date.parse(message.createdDateTime)) || Date.parse(message.createdDateTime) < started) continue;
      // HTML is parsed by the project's existing Teams text extractor in main.
      const text = message.text;
      if (!text?.trim() || text.startsWith(REPLY_PREFIX)) continue;
      if (text.length > 8000) throw new Error('测试输入过长，未发送给模型');
      const answer = await generate(text, signal);
      if (typeof answer !== 'string' || !answer.trim() || Buffer.byteLength(REPLY_PREFIX + answer, 'utf8') > 16000) throw new Error('模型回复为空或过长，未发送');
      signal.throwIfAborted();
      const current = await graph(`${path}/${encodeURIComponent(message.id)}`);
      if (current.deletedDateTime || current.text !== text || current.from?.user?.id !== me.id) throw new Error('测试输入已变化，未发送');
      signal.throwIfAborted();
      const receipt = await graph(path, { body: { contentType: 'text', content: REPLY_PREFIX + answer } });
      if (!receipt.id) throw new Error('发送结果未知，已停止，勿自动重试');
      seen.add(receipt.id);
      const delivered = await graph(`${path}/${encodeURIComponent(receipt.id)}`);
      if (delivered.text !== REPLY_PREFIX + answer) throw new Error('回复回读不一致，已停止，勿自动重试');
      replies++;
      console.log(JSON.stringify({ state: 'verified', replies }));
      if (seed || replies >= 3) return { replies };
    }
    await wait(3000, undefined, { signal });
  }
  return { replies };
}

async function main() {
  const { readFile, mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { createTeamsTokenProvider, SEND_SCOPE } = await import('../apps/server/dist/teams-auth.js');
  const { messageText } = await import('../apps/server/dist/teams-message-text.js');
  const { readConfig } = await import('../apps/server/dist/config.js');
  const { openModelSettings } = await import('../apps/server/dist/model-settings.js');
  const { createModelCatalog } = await import('../packages/runtime/dist/models.js');
  const config = readConfig(process.env);
  const username = process.argv[2];
  if (!username || !config.teamsConfigDir) throw new Error('需要测试账号参数及已有 TEAMS_CONFIG_DIR 配置');
  if (config.offline) throw new Error('离线模式不能进行真实 Teams 测试');
  const { account } = JSON.parse(await readFile(join(config.teamsConfigDir, 'teams-forward-config.json'), 'utf8'));
  if (!account || !['tenantId', 'clientId', 'username', 'password'].every(k => typeof account[k] === 'string' && account[k].trim())) throw new Error('需要已配置的 Teams 委托账号');
  const dir = await mkdtemp(join(tmpdir(), 'dee-teams-self-test-'));
  let settings;
  try {
    settings = await openModelSettings(dir, config.model, config.modelCatalogFile);
    let { models, agentModel, configured } = await createModelCatalog(settings.model);
    if (!configured) {
      const { loadPiModels } = await import('../apps/desktop/dist/pi-models.js');
      ({ models, agentModel, configured } = await loadPiModels({ cwd: process.cwd() }));
    }
    if (!configured) throw new Error('需要已有 LLM 环境配置、模型目录或本机 Pi 模型');
    const model = models.getModel(agentModel.provider, agentModel.modelId);
    const signal = AbortSignal.timeout(150_000);
    const readToken = createTeamsTokenProvider(account), sendToken = createTeamsTokenProvider(account, SEND_SCOPE);
    const graph = async (path, body) => {
      const url = new URL(path.startsWith('/') ? `https://graph.microsoft.com/v1.0${path}` : path);
      if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/') || url.username || url.password) throw new Error('Graph 地址无效');
      const token = await (body ? sendToken() : readToken());
      const response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw new Error(`Graph ${response.status}${body ? '，已停止；先核实发送结果，勿自动重试' : ''}`);
      const result = await response.json();
      const normalize = m => ({ ...m, text: messageText(m) });
      return Array.isArray(result.value) ? { ...result, value: result.value.map(normalize) } : normalize(result);
    };
    const generate = async (text, signal) => {
      const reply = await models.completeSimple(model, { systemPrompt: '你是 Dee。这是用户本人在 Teams 自聊中的 AI 自动回复测试。直接用简体中文简短回答消息，不声称执行任何外部操作。', messages: [{ role: 'user', content: text, timestamp: Date.now() }] }, { maxTokens: 600, signal });
      if (['error', 'aborted'].includes(reply.stopReason)) throw new Error('模型生成失败，未发送');
      return reply.content.filter(p => p.type === 'text').map(p => p.text).join('');
    };
    console.log('模型已连接，开始核对 Teams 账号与自聊会话。');
    const result = await testSelfChat({ graph, generate, username, chatId: process.env.TEAMS_SELF_CHAT_ID, signal, seed: process.argv.includes('--seed') ? '你好 Dee，请用一句话说明你能怎样帮助我整理工作消息。' : undefined });
    if (!result.replies) throw new Error('测试窗口内没有完成回复');
  } finally {
    settings?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  // Only our bounded login status code is safe to surface from authentication.
  const loginCode = /^Teams 登录失败：([a-z_0-9]+)$/.exec(error.message)?.[1];
  const networkCode = error.cause?.code;
  if (loginCode) console.error(`Teams 登录被拒绝：${loginCode}`);
  else if (typeof networkCode === 'string' && /^[A-Z_0-9]+$/.test(networkCode)) console.error(`网络连接失败：${networkCode}`);
  else if (error.message === '当前 Teams 账号与指定测试账号不一致' || error.message === '无法唯一确认与自己聊天，未发送') console.error(error.message);
  console.error('Teams 自聊测试未完成：请检查账号、Teams 和模型配置及发送回执；未自动重试。');
  process.exitCode = 1;
});
