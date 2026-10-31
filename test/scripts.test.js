import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/store.js';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const s = await startTestServer();
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}
const entriesOf = async (s) => (await s.get('/api/state')).json.entries;

test('"السكريبت جاهز": بيتحفظ لوحده ومن غير ما يمس نص السكريبت', async () => {
  await withServer(async (s) => {
    const [e] = await entriesOf(s);
    assert.equal(e.script_ready, false);
    await s.patch(`/api/entries/${e.id}`, { script: 'مسودة أولى' });
    let r = await s.patch(`/api/entries/${e.id}`, { script_ready: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.script_ready, true);
    assert.equal(r.json.script, 'مسودة أولى');
    const again = (await entriesOf(s)).find((x) => x.id === e.id);
    assert.equal(again.script_ready, true);
    r = await s.patch(`/api/entries/${e.id}`, { script_ready: false });
    assert.equal(r.json.script_ready, false);
  });
});

test('المخزن: إضافة وتعديل وحذف، ورفض الفاضي', async () => {
  await withServer(async (s) => {
    assert.equal((await s.post('/api/bank', { title: '', body: '  ' })).status, 400);
    assert.equal((await s.post('/api/bank', { title: 5 })).status, 400);
    const a = await s.post('/api/bank', { title: 'هوك الروبوت', body: 'الروبوت ده ممكن ياخد شغلك' });
    assert.equal(a.status, 201);
    const b = await s.post('/api/bank', { title: 'سكريبت تاني', body: 'نص' });
    const list = (await s.get('/api/bank')).json;
    assert.deepEqual(list.map((x) => x.id), [b.json.id, a.json.id]); // الأحدث الأول
    const p = await s.patch(`/api/bank/${a.json.id}`, { body: 'نص معدّل' });
    assert.equal(p.json.body, 'نص معدّل');
    assert.equal((await s.patch('/api/bank/9999', { body: 'x' })).status, 404);
    assert.equal((await s.del(`/api/bank/${b.json.id}`)).status, 200);
    assert.equal((await s.get('/api/bank')).json.length, 1);
  });
});

test('توزيع سكريبت من المخزن على مهمة: بيتنقل كمسودة وبيتشال من المخزن', async () => {
  await withServer(async (s) => {
    const entries = await entriesOf(s);
    const target = entries[3];
    const item = (await s.post('/api/bank', { title: 't', body: 'سكريبت للتوزيع' })).json;
    const r = await s.post(`/api/bank/${item.id}/assign`, { entry_id: target.id });
    assert.equal(r.status, 200);
    assert.equal(r.json.id, target.id);
    assert.equal(r.json.script, 'سكريبت للتوزيع');
    assert.equal(r.json.script_ready, false);
    assert.equal((await s.get('/api/bank')).json.length, 0);
    assert.equal((await entriesOf(s)).find((x) => x.id === target.id).script, 'سكريبت للتوزيع');
  });
});

test('التوزيع على مهمة فيها سكريبت: بيترفض (409) إلا لو أكّدت الاستبدال', async () => {
  await withServer(async (s) => {
    const [e] = await entriesOf(s);
    await s.patch(`/api/entries/${e.id}`, { script: 'سكريبتي الأصلي', script_ready: true });
    const item = (await s.post('/api/bank', { title: 't', body: 'الجديد' })).json;
    const refused = await s.post(`/api/bank/${item.id}/assign`, { entry_id: e.id });
    assert.equal(refused.status, 409);
    assert.equal((await entriesOf(s))[0].script, 'سكريبتي الأصلي');
    assert.equal((await s.get('/api/bank')).json.length, 1, 'المخزن متمسحش بعد الرفض');
    const ok = await s.post(`/api/bank/${item.id}/assign`, { entry_id: e.id, overwrite: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.script, 'الجديد');
    assert.equal(ok.json.script_ready, false, 'السكريبت الجديد مسودة لحد ما تعلّمه جاهز');
  });
});

test('التوزيع: أخطاء واضحة لمهمة أو سكريبت مش موجودين أو من غير مهمة', async () => {
  await withServer(async (s) => {
    const item = (await s.post('/api/bank', { title: 't', body: 'x' })).json;
    assert.equal((await s.post(`/api/bank/${item.id}/assign`, {})).status, 400);
    assert.equal((await s.post(`/api/bank/${item.id}/assign`, { entry_id: 99999 })).status, 404);
    assert.equal((await s.post('/api/bank/99999/assign', { entry_id: 1 })).status, 404);
    assert.equal((await s.get('/api/bank')).json.length, 1);
  });
});

test('ترقية قاعدة بيانات قديمة (من غير script_ready) من غير ما تضيع بياناتها', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-mig-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, week_start TEXT NOT NULL, template_id INTEGER, channel_id INTEGER,
    title TEXT NOT NULL, day INTEGER, is_video INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
    done_at TEXT, uploaded_at TEXT, upload_platforms TEXT NOT NULL DEFAULT '[]', script TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
    titles TEXT NOT NULL DEFAULT '[]', chosen_title TEXT NOT NULL DEFAULT '', thumb_prompt TEXT NOT NULL DEFAULT '', thumb_file TEXT NOT NULL DEFAULT '');
    INSERT INTO entries(week_start, title, script) VALUES('2026-10-24', 'قديم', 'سكريبت قديم');`);
  old.close();
  const db = openDb(file);
  const cols = db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name);
  assert.ok(cols.includes('script_ready'));
  const row = db.prepare('SELECT script, script_ready FROM entries').get();
  assert.equal(row.script, 'سكريبت قديم');
  assert.equal(row.script_ready, 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
