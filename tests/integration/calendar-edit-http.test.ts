import { freePort, post, launch, stop } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

test('日历计划编辑脱离事务草稿，支持修改、暂停和切回分钟规则', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-calendar-edit-'));
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch(dir, await freePort());
    const { id } = await post(app.origin, '/api/conversations');
    const prefix = '/api/conversations/' + id + '/schedules';
    const calendar = { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '08:00', timeZone: 'Asia/Shanghai' };
    const created = await post(app.origin, prefix, { text: '每日整理', calendar });
    const edit = prefix + '/' + created.item.id + '/edit';
    const modified = await post(app.origin, edit, { text: '调整后的整理', calendar: { ...calendar, timeZone: 'Asia/Tokyo' }, revision: created.item.revision });
    assert.equal(modified.item.calendar.timeZone, 'Asia/Tokyo');
    assert.equal(modified.item.status, 'active');
    const paused = await post(app.origin, prefix + '/' + created.item.id + '/pause');
    const editedPaused = await post(app.origin, edit, { text: '暂停时修改', calendar: { ...calendar, time: '09:30' }, revision: paused.item.revision });
    assert.equal(editedPaused.item.status, 'paused');
    assert.equal(editedPaused.item.calendar.time, '09:30');
    const minutes = await post(app.origin, edit, { text: '分钟计划', minutesFromNow: 10, everyMinutes: 30, revision: editedPaused.item.revision });
    assert.equal(minutes.item.calendar, undefined); assert.equal(minutes.item.everyMinutes, 30);
  } catch (error) { console.error(app?.getLogs()); throw error; }
  finally { if (app) await stop(app.child); const target = await realpath(dir); assert.ok(basename(target).startsWith('pi-calendar-edit-')); await rm(target, { recursive: true, force: true }); }
});
