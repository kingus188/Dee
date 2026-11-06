import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openTeamsArchive } from '/app/apps/server/dist/teams-archive-store.js';
import { teamsOriginalText } from '/app/apps/server/dist/teams-records.js';

const headers = { authorization: 'Basic ' + Buffer.from('demo:' + process.env.DEMO_PASSWORD).toString('base64') };
const root = 'http://127.0.0.1:3000';
const conversations = await (await fetch(root + '/api/conversations', { headers })).json();
assert.ok(conversations.length);
const controller = new AbortController();
const response = await fetch(root + '/api/conversations/' + encodeURIComponent(conversations[0].id) + '/events', { headers, signal: controller.signal });
assert.equal(response.status, 200);
const reader = response.body.getReader();
let text = '';
let view;
try {
  while (!text.includes('\n\n') && text.length < 2_000_000) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  view = JSON.parse(text.split('\n').find(line => line.startsWith('data:')).slice(5));
} finally {
  controller.abort();
  await reader.cancel().catch(() => {});
}
const previews = view.entries.filter(entry => entry.name === 'teams_messages');
assert.ok(previews.length);
const records = previews.flatMap(entry => [...entry.text.matchAll(/^<teams-records>([^\n]*)<\/teams-records>$/gm)].flatMap(match => JSON.parse(match[1])));
assert.ok(previews.every(entry => entry.text.includes('<teams-records>')));
assert.ok(records.length);
const db = new DatabaseSync('/data/agent.sqlite');
try {
  const archive = openTeamsArchive(db);
  for (const record of records) {
    const original = archive.message(record.chatId, record.id);
    assert.ok(original);
    assert.equal(record.sender, original.from?.user?.displayName || '未提供发送人');
    assert.equal(record.createdAt, original.createdDateTime);
    assert.equal(record.text, teamsOriginalText(original));
    assert.deepEqual(record.media, archive.mediaRows(record.chatId, record.id));
  }
  const image = records.flatMap(record => record.media).find(media => media.previewUrl);
  assert.ok(image);
  const resource = await fetch(root + image.previewUrl, { headers });
  assert.equal(resource.status, 200);
  assert.match(resource.headers.get('content-type'), /^image\//);
  assert.ok((await resource.arrayBuffer()).byteLength);
  console.log(JSON.stringify({ existingConversationRecovered: true, legacyQueries: previews.length, originalRecords: records.length,
    associatedMedia: records.reduce((count, record) => count + record.media.length, 0), senderTimeTextAndMediaMatchArchive: true, archivedImageHttp200: true }));
} finally { db.close(); }
