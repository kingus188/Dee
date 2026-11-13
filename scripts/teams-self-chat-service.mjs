import { readFile, mkdir, mkdtemp, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig } from '../apps/server/dist/config.js';
import { openModelSettings } from '../apps/server/dist/model-settings.js';
import { createTeamsTokenProvider, SEND_SCOPE } from '../apps/server/dist/teams-auth.js';
import { createSelfChatGenerator, startTeamsSelfChat } from '../apps/server/dist/teams-self-chat.js';
import { createModelCatalog } from '../packages/runtime/dist/models.js';

const config = readConfig(process.env);
const username = process.argv[2];
if (config.offline || !config.teamsConfigDir || !username || !process.env.TEAMS_SELF_CHAT_STATE_DIR) throw new Error('需要测试账号、TEAMS_CONFIG_DIR 和 TEAMS_SELF_CHAT_STATE_DIR，且不能离线');
const dir = resolve(process.env.TEAMS_SELF_CHAT_STATE_DIR);
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const temp = await mkdtemp(join(tmpdir(), 'dee-self-chat-model-'));
let settings, stop;
const controller = new AbortController();
let closing;
const close = () => closing ??= (async () => {
  controller.abort();
  try { await stop?.(); }
  finally { settings?.close(); await rm(temp, { recursive: true, force: true }); }
})();
process.once('SIGTERM', () => void close().catch(() => { process.exitCode = 1; }));
process.once('SIGINT', () => void close().catch(() => { process.exitCode = 1; }));
try {
  const { account } = JSON.parse(await readFile(join(config.teamsConfigDir, 'teams-forward-config.json'), 'utf8'));
  if (!account || !['tenantId', 'clientId', 'username', 'password'].every(k => typeof account[k] === 'string' && account[k].trim())) throw new Error('Teams 委托账号未配置');
  settings = await openModelSettings(temp, config.model, config.modelCatalogFile);
  let catalog = await createModelCatalog(settings.model);
  if (!catalog.configured) {
    const { loadPiModels } = await import('../apps/desktop/dist/pi-models.js');
    catalog = await loadPiModels({ cwd: process.cwd() });
  }
  if (!catalog.configured) throw new Error('模型未配置');
  controller.signal.throwIfAborted();
  let lastError = '';
  stop = startTeamsSelfChat({ dir, username, getToken: createTeamsTokenProvider(account),
    sendToken: createTeamsTokenProvider(account, SEND_SCOPE), generate: createSelfChatGenerator(catalog.models, catalog.agentModel), signal: controller.signal,
  }, error => {
    // Never log provider errors, message bodies or credentials.
    const reason = error instanceof Error && error.message.includes('结果未知') ? '发送结果未知，已暂停，需核实回执' : '读取、生成或发送未完成；失败消息不自动重发';
    if (reason !== lastError) console.error(`${new Date().toISOString()} Teams 自聊：${reason}`);
    lastError = reason;
  });
  console.error(`${new Date().toISOString()} Teams 自聊常驻测试已启动，仅限 48:notes`);
} catch {
  console.error('Teams 自聊常驻测试启动失败，请检查已有账号与模型配置');
  await close();
  process.exitCode = 1;
}
