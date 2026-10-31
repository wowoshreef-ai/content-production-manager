import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getSettings, getMeta, listTemplate, listChannels } from '../server/store.js';
import { seedDefaultWeek } from '../server/seed.js';
import { startTestServer } from './helpers.js';

test('الجدول الافتراضي: 4 قنوات بأيقوناتها و24 مهمة، الأسبوع من الجمعة والخميس إجازة', () => {
  const db = openDb(':memory:');
  assert.equal(seedDefaultWeek(db), true);
  const chans = listChannels(db);
  assert.deepEqual(chans.map((c) => [c.name, c.icon]), [['القيادي', '⚡'], ['رائج', '🔥'], ['عرب جيمرز', '🎮'], ['سائح', '✈️']]);
  const tpl = listTemplate(db);
  assert.equal(tpl.length, 24);
  const perDay = {};
  for (const t of tpl) perDay[t.day] = (perDay[t.day] ?? 0) + 1;
  assert.deepEqual(perDay, { 5: 4, 6: 4, 0: 4, 1: 4, 2: 4, 3: 4 }, '4 مهام في كل يوم ومفيش حاجة الخميس (4)');
  const titles = (d) => tpl.filter((t) => t.day === d).map((t) => t.title);
  assert.deepEqual(titles(5), ['فيديو 1', 'فيديو 2', 'فيديو ترند', 'فيديو جيمنج']); // الجمعة
  assert.equal(titles(6)[3], 'فيديو سياحي'); // السبت
  const s = getSettings(db);
  assert.equal(s.weekStartDay, 5);
  assert.deepEqual(s.workDays, [5, 6, 0, 1, 2, 3]);
  assert.equal(s.weeklyTarget, 18);
  assert.equal(getMeta(db, 'demo'), null, 'مش بيانات تجريبية');
  assert.equal(seedDefaultWeek(db), false, 'مبتتكررش');
});

test('24 مهمة والهدف 18: 18 = أسبوع كامل، والـ6 الباقيين بونص', async () => {
  const s = await startTestServer({ seed: false });
  try {
    seedDefaultWeek(s.db);
    const st = (await s.get('/api/state')).json;
    assert.equal(st.weekStart, '2026-10-23', 'الأسبوع بيبدأ الجمعة');
    assert.equal(st.demo, false);
    assert.equal(st.progress.totalVideos, 24);
    for (const e of st.entries.slice(0, 18)) await s.patch(`/api/entries/${e.id}`, { done: true });
    let p = (await s.get('/api/state')).json.progress;
    assert.deepEqual([p.percent, p.bonus, p.complete], [100, 0, true]);
    for (const e of st.entries.slice(18)) await s.patch(`/api/entries/${e.id}`, { done: true });
    p = (await s.get('/api/state')).json.progress;
    assert.deepEqual([p.done, p.percent, p.bonus], [24, 100, 6]);
  } finally {
    await s.close();
  }
});

test('أيقونة القناة: بتتحفظ وبتتعدّل وبتترفض لو طويلة، والقواعد القديمة بتترقّى', async () => {
  const s = await startTestServer();
  try {
    const c = await s.post('/api/channels', { name: 'جديدة', icon: '🚀' });
    assert.equal(c.json.icon, '🚀');
    assert.equal((await s.patch(`/api/channels/${c.json.id}`, { icon: '⭐' })).json.icon, '⭐');
    assert.equal((await s.patch(`/api/channels/${c.json.id}`, { icon: 'x'.repeat(20) })).status, 400);
    assert.equal((await s.get('/api/state')).json.channels.find((x) => x.id === c.json.id).icon, '⭐');
  } finally {
    await s.close();
  }
});
