import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { AppError, bad, notFound } from './errors.js';
import { isDateStr, monthRange, weekStartFor, zonedParts, addDays } from './dates.js';
import { computeProgress } from './progress.js';
import { configuredProviders, generateImage, generateTitles, pickProvider, proofreadScript } from './ai.js';
import { createPush } from './push.js';
import { runReminderCheck } from './scheduler.js';
import * as store from './store.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * بيبني تطبيق Express. كل التبعيات (قاعدة البيانات، البيئة، الوقت، fetch، مُرسل الإشعارات)
 * بتتمرّر من بره عشان نقدر نختبره من غير ما نكلّم أي خدمة حقيقية.
 */
export function createApp({ db, env = process.env, dataDir, now = () => new Date(), fetchImpl = fetch, pushSender } = {}) {
  const thumbDir = path.join(dataDir, 'thumbnails');
  fs.mkdirSync(thumbDir, { recursive: true });
  const push = createPush({ db, env, dataDir, sender: pushSender });
  const app = express();
  app.disable('x-powered-by');

  // ─ حماية اختيارية بكلمة سر (مهمة لو الموقع منشور على الإنترنت)
  if (env.BASIC_AUTH_USER && env.BASIC_AUTH_PASS) {
    app.use((req, res, next) => {
      const h = req.headers.authorization || '';
      if (h.startsWith('Basic ')) {
        const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
        if (safeEqual(u, env.BASIC_AUTH_USER) && safeEqual(rest.join(':'), env.BASIC_AUTH_PASS)) return next();
      }
      res.set('WWW-Authenticate', 'Basic realm="content-production-manager", charset="UTF-8"').status(401).send('مطلوب تسجيل دخول');
    });
  }

  app.use(express.json({ limit: '2mb' }));

  const ctx = () => {
    const settings = store.getSettings(db);
    const p = zonedParts(now(), settings.timezone);
    const currentWeekStart = weekStartFor(p.date, settings.weekStartDay);
    return { settings, today: p.date, todayWeekday: p.weekday, currentWeekStart };
  };
  const idParam = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw bad('رقم غير صحيح');
    return id;
  };
  const weekTarget = (c, weekStart) => store.getWeekRow(db, weekStart)?.target ?? c.settings.weeklyTarget;

  // ─────────────────────────── API ───────────────────────────
  const api = express.Router();

  api.get('/health', (req, res) => res.json({ ok: true }));

  api.get('/state', (req, res) => {
    const c = ctx();
    let weekStart = c.currentWeekStart;
    if (req.query.week !== undefined) {
      if (!isDateStr(req.query.week)) throw bad('تاريخ الأسبوع مش صح');
      weekStart = weekStartFor(req.query.week, c.settings.weekStartDay);
    }
    store.ensureWeek(db, weekStart, c.currentWeekStart, c.settings.weeklyTarget);
    const entries = store.listEntries(db, weekStart);
    const target = weekTarget(c, weekStart);
    const ai = configuredProviders(env);
    res.json({
      today: c.today,
      todayWeekday: c.todayWeekday,
      currentWeekStart: c.currentWeekStart,
      weekStart,
      prevWeek: addDays(weekStart, -7),
      nextWeek: addDays(weekStart, 7),
      isCurrentWeek: weekStart === c.currentWeekStart,
      settings: c.settings,
      channels: store.listChannels(db),
      template: store.listTemplate(db),
      entries,
      progress: computeProgress(entries, target),
      demo: !!store.getMeta(db, 'demo'),
      integrations: {
        aiProviders: ai,
        thumbnails: !!env.GEMINI_API_KEY,
        flowUrl: 'https://labs.google/fx/tools/flow',
        pushPublicKey: push.publicKey,
        pushSubscribers: store.countPushSubscriptions(db),
      },
    });
  });

  // ─ الإعدادات
  api.get('/settings', (req, res) => res.json(store.getSettings(db)));
  api.put('/settings', (req, res) => {
    const c = ctx();
    const settings = store.updateSettings(db, req.body, c.currentWeekStart);
    res.json(settings);
  });
  api.put('/workspace', (req, res) => {
    const c = ctx();
    res.json(store.saveWorkspace(db, req.body ?? {}, c.currentWeekStart));
  });

  // ─ القنوات
  api.get('/channels', (req, res) => res.json(store.listChannels(db)));
  api.post('/channels', (req, res) => res.status(201).json(store.createChannel(db, req.body ?? {})));
  api.patch('/channels/:id', (req, res) => {
    const ch = store.updateChannel(db, idParam(req), req.body ?? {});
    if (!ch) throw notFound('القناة مش موجودة');
    res.json(ch);
  });
  api.delete('/channels/:id', (req, res) => {
    if (!store.deleteChannel(db, idParam(req))) throw notFound('القناة مش موجودة');
    res.json({ ok: true });
  });

  // ─ قائمة المهام الثابتة
  api.get('/template', (req, res) => res.json(store.listTemplate(db)));
  api.put('/template', (req, res) => {
    const c = ctx();
    res.json(store.replaceTemplate(db, req.body?.tasks, c.currentWeekStart, c.settings.weeklyTarget));
  });

  // ─ مهام الأسبوع
  api.post('/entries', (req, res) => {
    const c = ctx();
    let weekStart = c.currentWeekStart;
    if (req.body?.week !== undefined) {
      if (!isDateStr(req.body.week)) throw bad('تاريخ الأسبوع مش صح');
      weekStart = weekStartFor(req.body.week, c.settings.weekStartDay);
    }
    store.ensureWeek(db, weekStart, c.currentWeekStart, c.settings.weeklyTarget);
    if (!store.getWeekRow(db, weekStart)) throw bad('مينفعش تضيف مهام لأسبوع فات');
    res.status(201).json(store.addEntry(db, weekStart, req.body ?? {}));
  });

  api.patch('/entries/:id', (req, res) => {
    const e = store.patchEntry(db, idParam(req), req.body ?? {});
    if (!e) throw notFound('المهمة مش موجودة');
    res.json(e);
  });

  api.delete('/entries/:id', (req, res) => {
    const row = store.deleteEntry(db, idParam(req));
    if (!row) throw notFound('المهمة مش موجودة');
    if (row.thumb_file) fs.rm(path.join(thumbDir, row.thumb_file), { force: true }, () => {});
    res.json({ ok: true });
  });

  api.post('/entries/:id/upload', (req, res) => {
    const c = ctx();
    const e = store.markUploaded(db, idParam(req), req.body?.platforms ?? [], c.settings.platforms);
    if (!e) throw notFound('المهمة مش موجودة');
    res.json(e);
  });
  api.delete('/entries/:id/upload', (req, res) => {
    const e = store.undoUpload(db, idParam(req));
    if (!e) throw notFound('المهمة مش موجودة');
    res.json(e);
  });

  // ─ مخزن السكريبتات وتوزيعها على المهام
  api.get('/bank', (req, res) => res.json(store.listBank(db)));
  api.post('/bank', (req, res) => res.status(201).json(store.createBank(db, req.body ?? {})));
  api.patch('/bank/:id', (req, res) => {
    const b = store.patchBank(db, idParam(req), req.body ?? {});
    if (!b) throw notFound('السكريبت مش موجود في المخزن');
    res.json(b);
  });
  api.delete('/bank/:id', (req, res) => {
    if (!store.deleteBank(db, idParam(req))) throw notFound('السكريبت مش موجود في المخزن');
    res.json({ ok: true });
  });
  api.post('/bank/:id/assign', (req, res) => {
    const entryId = Number(req.body?.entry_id);
    if (!Number.isInteger(entryId) || entryId < 1) throw bad('اختار المهمة اللي هتوزّع عليها');
    const r = store.assignBank(db, idParam(req), entryId, !!req.body?.overwrite);
    if (r.missing === 'bank') throw notFound('السكريبت مش موجود في المخزن');
    if (r.missing === 'entry') throw notFound('المهمة مش موجودة');
    res.json(r.entry);
  });

  // ─ الذكاء الاصطناعي: العناوين
  api.post('/entries/:id/titles', async (req, res) => {
    const entry = store.getEntry(db, idParam(req));
    if (!entry) throw notFound('المهمة مش موجودة');
    const c = ctx();
    const provider = pickProvider(env, req.body?.provider ?? c.settings.aiProvider);
    const count = Math.min(10, Math.max(1, Number(req.body?.count) || 5));
    const titles = await generateTitles({ env, provider, channel: entry.channel, entry, count, fetchImpl });
    store.saveTitles(db, entry.id, titles);
    res.json({ provider, titles, entry: store.getEntry(db, entry.id) });
  });

  // ─ التدقيق الإملائي للسكريبت عبر Gemini
  api.post('/entries/:id/proofread', async (req, res) => {
    const id = idParam(req);
    const entry = store.getEntry(db, id);
    if (!entry) throw notFound('المهمة مش موجودة');
    const corrected = await proofreadScript({ env, script: entry.script, fetchImpl });
    const updated = store.patchEntry(db, id, { script: corrected });
    if (!updated) throw notFound('المهمة مش موجودة');
    res.json({ script: corrected, entry: store.getEntry(db, id) });
  });

  // ─ الذكاء الاصطناعي: الصورة المصغرة
  api.post('/entries/:id/thumbnail', async (req, res) => {
    const id = idParam(req);
    const entry = store.getEntry(db, id);
    if (!entry) throw notFound('المهمة مش موجودة');
    const c = ctx();
    const prompt = String(req.body?.prompt ?? '').trim() || entry.suggested_thumb_prompt;
    if (prompt.length > 5000) throw bad('البرومبت طويل أوي');
    const img = await generateImage({ env, prompt, aspect: c.settings.thumbAspect, fetchImpl });
    const file = `${id}-${Date.now()}.${img.ext}`;
    fs.writeFileSync(path.join(thumbDir, file), img.buffer);
    const old = store.getEntryRow(db, id)?.thumb_file;
    store.saveThumbnail(db, id, file, prompt);
    if (old && old !== file) fs.rm(path.join(thumbDir, old), { force: true }, () => {});
    res.json({ entry: store.getEntry(db, id) });
  });

  // ─ السجل
  api.get('/history', (req, res) => {
    const c = ctx();
    const { from, to } = monthRange(c.today);
    res.json({
      weeks: store.weeksHistory(db),
      month: { from, to, channels: store.monthlyCommitment(db, from, to) },
      resets: store.listResetLog(db),
    });
  });

  // ─ تصفير الأسبوع الحالي (محمي بكلمة سر)
  api.post('/reset', (req, res) => {
    const expected = env.RESET_PASSWORD || 'changeme';
    if (!safeEqual(req.body?.password ?? '', expected)) throw new AppError(403, 'كلمة السر غلط');
    const c = ctx();
    const files = store.resetWeek(db, c.currentWeekStart, c.currentWeekStart, c.settings.weeklyTarget);
    for (const f of files) fs.rm(path.join(thumbDir, f), { force: true }, () => {});
    res.json({ ok: true });
  });

  // ─ الإشعارات
  api.post('/push/subscribe', (req, res) => {
    store.savePushSubscription(db, req.body?.subscription);
    res.status(201).json({ ok: true });
  });
  api.post('/push/unsubscribe', (req, res) => {
    store.removePushSubscription(db, String(req.body?.endpoint ?? ''));
    res.json({ ok: true });
  });
  api.post('/push/test', async (req, res) => {
    const r = await push.sendAll({ title: '🔔 إشعار تجريبي', body: 'الإشعارات شغالة تمام على الجهاز ده.', tag: 'test', url: '/' });
    if (r.total === 0) throw bad('مفيش جهاز مشترك في الإشعارات. فعّل الإشعارات الأول.');
    res.json(r);
  });
  api.post('/reminders/run', async (req, res) => {
    res.json(await runReminderCheck({ db, push, now, force: true }));
  });

  api.use((req, res) => res.status(404).json({ error: 'المسار مش موجود' }));
  app.use('/api', api);

  // ─ ملفات ثابتة
  app.use('/thumbs', express.static(thumbDir, { maxAge: '7d', immutable: true, index: false }));
  app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache').set('Service-Worker-Allowed', '/').type('js').sendFile(path.join(PUBLIC_DIR, 'sw.js'));
  });
  app.use(express.static(PUBLIC_DIR, { maxAge: 0, index: 'index.html' }));

  // ─ معالج الأخطاء
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON مش صح' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'الطلب كبير أوي' });
    console.error('[error]', err);
    res.status(500).json({ error: 'حصل خطأ غير متوقع في السيرفر' });
  });

  return { app, push, ctx };
}
