import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, mockFetch, NOW, WEEK_START } from './helpers.js';
import { runReminderCheck } from '../server/scheduler.js';

async function withServer(opts, fn) {
  const s = await startTestServer(opts);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}
const state = async (s, q = '') => (await s.get(`/api/state${q}`)).json;

test('الحالة: بيتجهّز الأسبوع الحالي من 18 مهمة تجريبية', () =>
  withServer({}, async (s) => {
    const d = await state(s);
    assert.equal(d.weekStart, WEEK_START);
    assert.equal(d.today, '2026-10-27');
    assert.equal(d.entries.length, 18);
    assert.equal(d.progress.target, 18);
    assert.equal(d.progress.done, 0);
    assert.equal(d.progress.percent, 0);
    assert.equal(d.channels.length, 4);
    assert.equal(d.demo, true);
  }));

test('18 فيديو = أسبوع كامل، والفيديوهات الزيادة بونص', () =>
  withServer({}, async (s) => {
    let d = await state(s);
    for (const e of d.entries) assert.equal((await s.patch(`/api/entries/${e.id}`, { done: true })).status, 200);
    d = await state(s);
    assert.equal(d.progress.percent, 100);
    assert.equal(d.progress.complete, true);
    assert.equal(d.progress.bonus, 0);

    for (let i = 0; i < 2; i++) {
      const r = await s.post('/api/entries', { title: `بونص ${i + 1}`, channel_id: d.channels[0].id });
      assert.equal(r.status, 201);
      await s.patch(`/api/entries/${r.json.id}`, { done: true });
    }
    d = await state(s);
    assert.equal(d.progress.done, 20);
    assert.equal(d.progress.percent, 100);
    assert.equal(d.progress.bonus, 2);
  }));

test('زر تم الرفع: بيسجّل الرفع ويعلّم الفيديو منجز، والتراجع بيشيل الرفع بس', () =>
  withServer({}, async (s) => {
    const { entries } = await state(s);
    const id = entries[0].id;
    const up = await s.post(`/api/entries/${id}/upload`, { platforms: ['TikTok', 'YouTube Shorts'] });
    assert.equal(up.status, 200);
    assert.equal(up.json.done, true);
    assert.ok(up.json.uploaded_at);
    assert.deepEqual(up.json.upload_platforms, ['TikTok', 'YouTube Shorts']);
    assert.equal((await state(s)).progress.uploaded, 1);

    const undo = await s.del(`/api/entries/${id}/upload`);
    assert.equal(undo.json.uploaded_at, null);
    assert.equal(undo.json.done, true);

    await s.post(`/api/entries/${id}/upload`, {});
    const uncheck = await s.patch(`/api/entries/${id}`, { done: false });
    assert.equal(uncheck.json.done, false);
    assert.equal(uncheck.json.uploaded_at, null); // الرفع بيتلغي لو شلت "تم"

    assert.equal((await s.post(`/api/entries/${id}/upload`, { platforms: ['منصة مش موجودة'] })).status, 400);
  }));

test('السكريبت والملاحظات والروابط بتتحفظ وترجع بعد إعادة التحميل', () =>
  withServer({}, async (s) => {
    const { entries } = await state(s);
    const id = entries[3].id;
    const script = 'السطر الأول\nالسطر التاني\n'.repeat(200);
    const notes = 'المصدر: https://example.com/a?x=1\nملحوظة تانية';
    assert.equal((await s.patch(`/api/entries/${id}`, { script, notes })).status, 200);
    const e = (await state(s)).entries.find((x) => x.id === id);
    assert.equal(e.script, script);
    assert.equal(e.notes, notes);
    assert.equal((await s.patch(`/api/entries/${id}`, { script: 123 })).status, 400);
    assert.equal((await s.patch(`/api/entries/99999`, { script: 'x' })).status, 404);
  }));

test('الإعدادات: الهدف وأيام الشغل، والتحقق من القيم الغلط', () =>
  withServer({}, async (s) => {
    const r = await s.put('/api/settings', { weeklyTarget: 10, workDays: [6, 0, 1], reminderTime: '09:30' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.workDays, [6, 0, 1]);
    const d = await state(s);
    assert.equal(d.progress.target, 10);
    assert.deepEqual(d.settings.workDays, [6, 0, 1]);

    for (const bad of [{ workDays: [] }, { workDays: [9] }, { reminderTime: '25:99' }, { weeklyTarget: 0 }, { timezone: 'Mars/Base' }, { aiProvider: 'x' }]) {
      assert.equal((await s.put('/api/settings', bad)).status, 400, JSON.stringify(bad));
    }
  }));

test('تعديل قائمة المهام الثابتة بيتطبق على الأسبوع الحالي من غير ما يضيّع الشغل', () =>
  withServer({}, async (s) => {
    const tpl = (await s.get('/api/template')).json;
    assert.equal(tpl.length, 18);
    const d0 = await state(s);
    const withWork = d0.entries.find((e) => e.template_id === tpl[1].id);
    await s.patch(`/api/entries/${withWork.id}`, { script: 'سكريبت مهم' });

    const next = [
      { ...tpl[0], title: 'عنوان معدّل', day: 3 }, // تعديل
      // tpl[1] اتحذفت (فيها سكريبت → لازم تفضل)
      tpl[2],
      { channel_id: tpl[0].channel_id, title: 'مهمة جديدة', day: null, is_video: false }, // جديدة
    ];
    const put = await s.put('/api/template', { tasks: next });
    assert.equal(put.status, 200);
    assert.equal(put.json.length, 3);

    const d = await state(s);
    const titles = d.entries.map((e) => e.title);
    assert.ok(titles.includes('عنوان معدّل'));
    assert.ok(titles.includes('مهمة جديدة'));
    const kept = d.entries.find((e) => e.id === withWork.id);
    assert.ok(kept, 'المهمة اللي فيها سكريبت لازم تفضل');
    assert.equal(kept.template_id, null);
    assert.equal(d.entries.length, 1 /* معدّلة */ + 1 /* tpl[2] */ + 1 /* جديدة */ + 1 /* محتفظ بيها */ + 0);
    assert.equal(d.entries.filter((e) => !e.script && e.template_id === null).length, 0);
    // المهمة العادية مش بتتحسب في الهدف
    assert.equal(d.progress.totalVideos, 3);
    assert.equal(d.progress.otherTotal, 1);
  }));

test('تنقل بين الأسابيع: الماضي فاضي، والجاي بيتجهّز من القائمة', () =>
  withServer({}, async (s) => {
    const past = await state(s, '?week=2026-10-17');
    assert.equal(past.weekStart, '2026-10-17');
    assert.equal(past.entries.length, 0);
    assert.equal((await s.post('/api/entries', { title: 'x', week: '2026-10-17' })).status, 400);
    const future = await state(s, '?week=2026-10-31');
    assert.equal(future.weekStart, '2026-10-31');
    assert.equal(future.entries.length, 18);
    assert.equal((await s.get('/api/state?week=nope')).status, 400);
  }));

test('السجل والالتزام الشهري لكل قناة', () =>
  withServer({}, async (s) => {
    const d = await state(s);
    const ch = d.channels[0];
    const mine = d.entries.filter((e) => e.channel_id === ch.id);
    for (const e of mine.slice(0, 2)) await s.patch(`/api/entries/${e.id}`, { done: true });
    const h = (await s.get('/api/history')).json;
    assert.equal(h.weeks.length, 1);
    assert.equal(h.weeks[0].done, 2);
    const row = h.month.channels.find((c) => c.channel_id === ch.id);
    assert.equal(row.done, 2);
    assert.equal(row.planned, mine.length);
    assert.equal(row.percent, Math.floor((2 / mine.length) * 100));
  }));

test('تصفير الأسبوع: محتاج كلمة السر الصح وبيسجّل في السجل', () =>
  withServer({}, async (s) => {
    const d = await state(s);
    await s.patch(`/api/entries/${d.entries[0].id}`, { done: true, script: 'هيتمسح' });
    assert.equal((await s.post('/api/reset', { password: 'غلط' })).status, 403);
    assert.equal((await state(s)).progress.done, 1);
    assert.equal((await s.post('/api/reset', { password: 'test-pass' })).status, 200);
    const after = await state(s);
    assert.equal(after.progress.done, 0);
    assert.equal(after.entries.length, 18);
    assert.ok(after.entries.every((e) => e.script === ''));
    const h = (await s.get('/api/history')).json;
    assert.equal(h.resets.length, 1);
    assert.equal(h.resets[0].done, 1);
  }));

test('توليد العناوين بـ Claude (طلب وهمي): بيبعت المفتاح والسكريبت ويحفظ النتيجة', () => {
  const fetchImpl = mockFetch(() => ({ body: { content: [{ type: 'text', text: '["الروبوت ده هياخد شغلك؟","الشركة دي قلبت السوق","عنوان تالت"]' }] } }));
  return withServer({ env: { ANTHROPIC_API_KEY: 'sk-test-123' }, fetchImpl }, async (s) => {
    const { entries } = await state(s);
    const id = entries[0].id;
    await s.patch(`/api/entries/${id}`, { script: 'سكريبت عن الذكاء الاصطناعي والوظائف' });
    const r = await s.post(`/api/entries/${id}/titles`, { count: 3 });
    assert.equal(r.status, 200);
    assert.equal(r.json.provider, 'anthropic');
    assert.equal(r.json.titles.length, 3);
    assert.equal(r.json.entry.titles.length, 3);

    const call = fetchImpl.calls[0];
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(call.init.headers['x-api-key'], 'sk-test-123');
    assert.match(JSON.parse(call.init.body).messages[0].content, /سكريبت عن الذكاء الاصطناعي/);

    const picked = await s.patch(`/api/entries/${id}`, { chosen_title: r.json.titles[1] });
    assert.equal(picked.json.chosen_title, 'الشركة دي قلبت السوق');
  });
});

test('توليد العناوين بـ Gemini و OpenAI (طلب وهمي)', async () => {
  const gem = mockFetch(() => ({ body: { candidates: [{ content: { parts: [{ text: '["عنوان جيميني"]' }] } }] } }));
  await withServer({ env: { GEMINI_API_KEY: 'g-key' }, fetchImpl: gem }, async (s) => {
    const { entries } = await state(s);
    const r = await s.post(`/api/entries/${entries[0].id}/titles`, {});
    assert.deepEqual(r.json.titles, ['عنوان جيميني']);
    assert.match(gem.calls[0].url, /generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent/);
    assert.equal(gem.calls[0].init.headers['x-goog-api-key'], 'g-key');
  });
  const oai = mockFetch(() => ({ body: { choices: [{ message: { content: '["عنوان أوبن إيه آي"]' } }] } }));
  await withServer({ env: { OPENAI_API_KEY: 'o-key' }, fetchImpl: oai }, async (s) => {
    const { entries } = await state(s);
    const r = await s.post(`/api/entries/${entries[0].id}/titles`, { provider: 'openai' });
    assert.deepEqual(r.json.titles, ['عنوان أوبن إيه آي']);
    assert.equal(oai.calls[0].init.headers.authorization, 'Bearer o-key');
  });
});

test('العناوين: من غير مفتاح → 400 برسالة واضحة، وخطأ المزوّد → 502 من غير تسريب المفتاح', async () => {
  await withServer({}, async (s) => {
    const { entries } = await state(s);
    const r = await s.post(`/api/entries/${entries[0].id}/titles`, {});
    assert.equal(r.status, 400);
    assert.match(r.json.error, /\.env/);
  });
  const failing = mockFetch(() => ({ status: 401, body: { error: { message: 'invalid x-api-key' } } }));
  await withServer({ env: { ANTHROPIC_API_KEY: 'sk-secret-999' }, fetchImpl: failing }, async (s) => {
    const { entries } = await state(s);
    const r = await s.post(`/api/entries/${entries[0].id}/titles`, {});
    assert.equal(r.status, 502);
    assert.ok(!r.text.includes('sk-secret-999'));
  });
});

test('توليد الصورة المصغرة بـ Gemini (طلب وهمي): بيحفظ الصورة ويقدّمها', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const fetchImpl = mockFetch(() => ({ body: { candidates: [{ content: { parts: [{ text: 'تمام' }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] } }));
  await withServer({ env: { GEMINI_API_KEY: 'g-key' }, fetchImpl }, async (s) => {
    const d = await state(s);
    assert.equal(d.integrations.thumbnails, true);
    const id = d.entries[0].id;
    const r = await s.post(`/api/entries/${id}/thumbnail`, { prompt: 'thumbnail about robots' });
    assert.equal(r.status, 200);
    assert.match(r.json.entry.thumb_url, /^\/thumbs\/\d+-\d+\.png$/);
    assert.equal(r.json.entry.thumb_prompt, 'thumbnail about robots');
    const body = JSON.parse(fetchImpl.calls[0].init.body);
    assert.equal(body.generationConfig.imageConfig.aspectRatio, '16:9');
    assert.equal(body.contents[0].parts[0].text, 'thumbnail about robots');
    const img = await fetch(s.base + r.json.entry.thumb_url);
    assert.equal(img.status, 200);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
  });
  await withServer({}, async (s) => {
    const { entries } = await state(s);
    const r = await s.post(`/api/entries/${entries[0].id}/thumbnail`, {});
    assert.equal(r.status, 400);
    assert.match(r.json.error, /GEMINI_API_KEY/);
  });
  const noImage = mockFetch(() => ({ body: { candidates: [{ content: { parts: [{ text: 'مقدرش' }] } }] } }));
  await withServer({ env: { GEMINI_API_KEY: 'g-key' }, fetchImpl: noImage }, async (s) => {
    const { entries } = await state(s);
    assert.equal((await s.post(`/api/entries/${entries[0].id}/thumbnail`, {})).status, 502);
  });
});

test('الإشعارات: الاشتراك والإشعار التجريبي', () =>
  withServer({}, async (s) => {
    assert.equal((await s.post('/api/push/subscribe', { subscription: { endpoint: 'http://insecure', keys: {} } })).status, 400);
    assert.equal((await s.post('/api/push/test')).status, 400); // مفيش مشتركين
    const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } };
    assert.equal((await s.post('/api/push/subscribe', { subscription: sub })).status, 201);
    assert.equal((await state(s)).integrations.pushSubscribers, 1);
    assert.ok((await state(s)).integrations.pushPublicKey.length > 40);
    const t = await s.post('/api/push/test');
    assert.equal(t.json.sent, 1);
    assert.equal(s.sent.length, 1);
    assert.match(s.sent[0].payload.title, /تجريبي/);
    await s.post('/api/push/unsubscribe', { endpoint: sub.endpoint });
    assert.equal((await state(s)).integrations.pushSubscribers, 0);
  }));

test('التذكير اليومي: مرة واحدة في اليوم، بعد الميعاد، وفي أيام الشغل بس', () =>
  withServer({}, async (s) => {
    const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } };
    await s.post('/api/push/subscribe', { subscription: sub });
    const run = (now) => runReminderCheck({ db: s.db, push: s.push, now: () => now });
    // محتاج ميعاد تذكير معروف: 10:00 بتوقيت القاهرة
    await s.put('/api/settings', { reminderTime: '10:00' });

    assert.equal((await run(new Date('2026-10-27T05:00:00Z'))).reason, 'too-early'); // 08:00 أو 07:00 محلي
    const first = await run(NOW); // 12:00 أو 11:00 محلي
    assert.equal(first.reason, 'sent');
    assert.equal(s.sent.length, 1);
    assert.match(s.sent[0].payload.title, /مهام|مهمة/);
    assert.equal((await run(NOW)).reason, 'already-sent');
    assert.equal(s.sent.length, 1);

    // يوم تاني، لكن مش يوم شغل
    await s.put('/api/settings', { workDays: [6, 0, 1] }); // الثلاثاء (2) إجازة
    assert.equal((await run(new Date('2026-10-28T09:00:00Z'))).reason, 'not-a-work-day');
    await s.put('/api/settings', { workDays: [6, 0, 1, 2, 3, 4], reminderEnabled: false });
    assert.equal((await run(new Date('2026-10-28T09:00:00Z'))).reason, 'disabled');
    await s.put('/api/settings', { reminderEnabled: true });
    assert.equal((await run(new Date('2026-10-28T09:00:00Z'))).reason, 'sent');
    assert.equal(s.sent.length, 2);
  }));

test('التذكير: لو كل مهام النهاردة خلصت مفيش إشعار', () =>
  withServer({}, async (s) => {
    await s.post('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/z', keys: { p256dh: 'k', auth: 'a' } } });
    const d = await state(s);
    for (const e of d.entries) await s.patch(`/api/entries/${e.id}`, { done: true });
    const r = await runReminderCheck({ db: s.db, push: s.push, now: () => NOW });
    assert.equal(r.reason, 'nothing-pending');
    assert.equal(s.sent.length, 0);
  }));

test('حماية اختيارية بكلمة سر (Basic Auth)', () =>
  withServer({ env: { BASIC_AUTH_USER: 'sherif', BASIC_AUTH_PASS: 's3cret' } }, async (s) => {
    assert.equal((await s.get('/api/state')).status, 401);
    const good = 'Basic ' + Buffer.from('sherif:s3cret').toString('base64');
    const bad = 'Basic ' + Buffer.from('sherif:wrong').toString('base64');
    assert.equal((await s.get('/api/state', { authorization: good })).status, 200);
    assert.equal((await s.get('/api/state', { authorization: bad })).status, 401);
  }));

test('الصفحة والملفات الثابتة بتتقدّم، وJSON الغلط بيرجع 400', () =>
  withServer({}, async (s) => {
    const home = await s.get('/');
    assert.equal(home.status, 200);
    assert.match(home.text, /dir="rtl"/);
    assert.match(home.text, /مدير إنتاج المحتوى/);
    const sw = await s.get('/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.text, /showNotification/);
    assert.equal((await s.get('/theme.css')).status, 200);
    assert.equal((await s.get('/manifest.webmanifest')).status, 200);
    const badJson = await fetch(s.base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(badJson.status, 400);
    assert.equal((await s.get('/api/nope')).status, 404);
  }));

test('القنوات: إضافة وتعديل وحذف (والمهام بتفضل من غير قناة)', () =>
  withServer({}, async (s) => {
    const c = await s.post('/api/channels', { name: 'قناة جديدة', color: '#112233', style: 'هادي' });
    assert.equal(c.status, 201);
    assert.equal((await s.post('/api/channels', { name: '', color: '#112233' })).status, 400);
    assert.equal((await s.post('/api/channels', { name: 'x', color: 'red' })).status, 400);
    assert.equal((await s.patch(`/api/channels/${c.json.id}`, { name: 'اسم تاني' })).json.name, 'اسم تاني');
    const extra = await s.post('/api/entries', { title: 'فيديو القناة الجديدة', channel_id: c.json.id });
    assert.equal(extra.json.channel.name, 'اسم تاني');
    assert.equal((await s.del(`/api/channels/${c.json.id}`)).status, 200);
    const after = (await state(s)).entries.find((e) => e.id === extra.json.id);
    assert.equal(after.channel_id, null);
    assert.equal((await s.del(`/api/channels/${c.json.id}`)).status, 404);
  }));
