import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError, bad } from './errors.js';
import { isValidTimezone } from './dates.js';
import { buildThumbnailPrompt } from './ai.js';

export const DEFAULT_SETTINGS = {
  weeklyTarget: 18,
  workDays: [6, 0, 1, 2, 3, 4], // 0 = الأحد ... 6 = السبت (الجمعة إجازة افتراضيًا)
  weekStartDay: 6, // السبت
  reminderEnabled: true,
  reminderTime: '10:00',
  timezone: 'Africa/Cairo',
  aiProvider: 'auto',
  thumbAspect: '16:9',
  platforms: ['TikTok', 'Instagram Reels', 'YouTube Shorts', 'Facebook Reels'],
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#4f8cff',
  icon TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  title_prompt TEXT NOT NULL DEFAULT '',
  image_prompt TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS template_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  day INTEGER,
  is_video INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS weeks (
  week_start TEXT PRIMARY KEY,
  target INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  template_id INTEGER,
  channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  day INTEGER,
  is_video INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  uploaded_at TEXT,
  upload_platforms TEXT NOT NULL DEFAULT '[]',
  script TEXT NOT NULL DEFAULT '',
  script_ready INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  titles TEXT NOT NULL DEFAULT '[]',
  chosen_title TEXT NOT NULL DEFAULT '',
  thumb_prompt TEXT NOT NULL DEFAULT '',
  thumb_file TEXT NOT NULL DEFAULT '',
  UNIQUE (week_start, template_id)
);
CREATE INDEX IF NOT EXISTS idx_entries_week ON entries(week_start);
CREATE TABLE IF NOT EXISTS script_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reset_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  done INTEGER NOT NULL,
  target INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

const MIGRATIONS = [
  {
    version: 1,
    name: 'script-ready-flag',
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(entries)').all().map((column) => column.name);
      if (!columns.includes('script_ready')) db.exec('ALTER TABLE entries ADD COLUMN script_ready INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 2,
    name: 'channel-prompts-and-icon',
    apply(db) {
      const columns = new Set(db.prepare('PRAGMA table_info(channels)').all().map((column) => column.name));
      if (!columns.has('icon')) db.exec("ALTER TABLE channels ADD COLUMN icon TEXT NOT NULL DEFAULT ''");
      if (!columns.has('title_prompt')) db.exec("ALTER TABLE channels ADD COLUMN title_prompt TEXT NOT NULL DEFAULT ''");
      if (!columns.has('image_prompt')) db.exec("ALTER TABLE channels ADD COLUMN image_prompt TEXT NOT NULL DEFAULT ''");
    },
  },
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  for (const migration of MIGRATIONS) {
    const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(migration.version);
    if (applied) continue;
    tx(db, () => {
      migration.apply(db);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
  }
  return db;
}

const transactionDepth = new WeakMap();

export function tx(db, fn) {
  const depth = transactionDepth.get(db) ?? 0;
  const savepoint = `nested_${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  transactionDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  } finally {
    if (depth === 0) transactionDepth.delete(db);
    else transactionDepth.set(db, depth);
  }
}

const num = (v) => Number(v);

// ───────────── الإعدادات ─────────────

export function getSettings(db) {
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    if (r.key in DEFAULT_SETTINGS) {
      try {
        s[r.key] = JSON.parse(r.value);
      } catch {
        /* القيمة بايظة → نكمل بالافتراضي */
      }
    }
  }
  return s;
}

const upsertSetting = (db, key, value) =>
  db
    .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));

export const getMeta = (db, key) => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(`meta:${key}`);
  return r ? JSON.parse(r.value) : null;
};
export const setMeta = (db, key, value) => upsertSetting(db, `meta:${key}`, value);

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

export function validateSettingsPatch(patch) {
  const out = {};
  if (typeof patch !== 'object' || patch === null) throw bad('بيانات الإعدادات مش صح');
  if ('weeklyTarget' in patch) {
    if (!isInt(patch.weeklyTarget, 1, 200)) throw bad('هدف الأسبوع لازم يكون رقم من 1 لـ 200');
    out.weeklyTarget = patch.weeklyTarget;
  }
  if ('workDays' in patch) {
    const w = patch.workDays;
    if (!Array.isArray(w) || !w.length || !w.every((d) => isInt(d, 0, 6))) throw bad('لازم تختار يوم شغل واحد على الأقل');
    out.workDays = [...new Set(w)];
  }
  if ('weekStartDay' in patch) {
    if (!isInt(patch.weekStartDay, 0, 6)) throw bad('يوم بداية الأسبوع مش صح');
    out.weekStartDay = patch.weekStartDay;
  }
  if ('reminderEnabled' in patch) out.reminderEnabled = !!patch.reminderEnabled;
  if ('reminderTime' in patch) {
    const m = /^(\d{2}):(\d{2})$/.exec(patch.reminderTime ?? '');
    if (!m || +m[1] > 23 || +m[2] > 59) throw bad('وقت التذكير لازم يكون بصيغة HH:MM');
    out.reminderTime = patch.reminderTime;
  }
  if ('timezone' in patch) {
    if (typeof patch.timezone !== 'string' || !isValidTimezone(patch.timezone)) throw bad('المنطقة الزمنية مش صح');
    out.timezone = patch.timezone;
  }
  if ('aiProvider' in patch) {
    if (!['auto', 'anthropic', 'gemini', 'openai'].includes(patch.aiProvider)) throw bad('مزوّد الذكاء الاصطناعي مش مدعوم');
    out.aiProvider = patch.aiProvider;
  }
  if ('thumbAspect' in patch) {
    if (!['16:9', '9:16', '1:1', '4:3'].includes(patch.thumbAspect)) throw bad('أبعاد الصورة مش مدعومة');
    out.thumbAspect = patch.thumbAspect;
  }
  if ('platforms' in patch) {
    const p = patch.platforms;
    if (!Array.isArray(p) || p.length > 12 || !p.every((x) => typeof x === 'string' && x.trim() && x.length <= 40)) {
      throw bad('قائمة المنصات مش صح');
    }
    out.platforms = [...new Set(p.map((x) => x.trim()))];
  }
  return out;
}

export function updateSettings(db, patch, currentWeekStart) {
  const clean = validateSettingsPatch(patch);
  tx(db, () => {
    for (const [k, v] of Object.entries(clean)) upsertSetting(db, k, v);
    if (clean.weeklyTarget && currentWeekStart) {
      db.prepare('UPDATE weeks SET target = ? WHERE week_start = ?').run(clean.weeklyTarget, currentWeekStart);
    }
  });
  return getSettings(db);
}

/** Saves settings, channel prompts, and the weekly template as one local transaction. */
export function saveWorkspace(db, { settings, channels, tasks, deletedChannels = [] }, currentWeekStart) {
  if (
    !Array.isArray(channels) ||
    channels.length > 50 ||
    !channels.every((channel) => channel && typeof channel === 'object') ||
    !Array.isArray(tasks) ||
    tasks.length > 200 ||
    !tasks.every((task) => task && typeof task === 'object')
  ) {
    throw bad('بيانات مساحة العمل مش صح');
  }
  if (!Array.isArray(deletedChannels) || !deletedChannels.every((id) => Number.isInteger(id) && id > 0)) {
    throw bad('قائمة القنوات المحذوفة مش صح');
  }

  return tx(db, () => {
    const ids = new Map();
    const deleted = new Set(deletedChannels);
    for (const channel of channels) {
      if (ids.has(channel.id)) throw bad('القناة مكررة في بيانات الإعدادات');
      const body = {
        name: channel.name,
        color: channel.color,
        style: channel.style,
        icon: channel.icon ?? '',
        title_prompt: channel.title_prompt ?? '',
        image_prompt: channel.image_prompt ?? '',
      };
      if (Number.isInteger(channel.id) && channel.id > 0) {
        if (!updateChannel(db, channel.id, body)) throw bad('قناة من القائمة مش موجودة');
        ids.set(channel.id, channel.id);
      } else if (Number.isInteger(channel.id) && channel.id < 0) {
        ids.set(channel.id, createChannel(db, body).id);
      } else {
        throw bad('معرّف القناة مش صح');
      }
      if (deleted.has(channel.id)) throw bad('القناة لا يمكن تعديلها وحذفها في نفس الوقت');
    }

    const mappedTasks = tasks.map((task) => ({
      ...task,
      channel_id: task.channel_id == null ? null : ids.get(task.channel_id) ?? task.channel_id,
    }));
    const savedSettings = updateSettings(db, settings, currentWeekStart);
    for (const id of deletedChannels) {
      if (!deleteChannel(db, id)) throw bad('قناة محددة للحذف مش موجودة');
    }
    replaceTemplate(db, mappedTasks, currentWeekStart, savedSettings.weeklyTarget);
    return { settings: savedSettings, channels: listChannels(db), tasks: listTemplate(db) };
  });
}

// ───────────── القنوات ─────────────

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function listChannels(db) {
  return db.prepare('SELECT id, name, color, icon, style, title_prompt, image_prompt, position FROM channels ORDER BY position, id').all().map((c) => ({ ...c }));
}

const cleanIcon = (v) => {
  if (typeof v !== 'string' || [...v.trim()].length > 4) throw bad('الأيقونة إيموجي واحد (4 حروف بحد أقصى)');
  return v.trim();
};

export function createChannel(db, { name, color = '#4f8cff', style = '', icon = '', title_prompt = '', image_prompt = '' }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 60) throw bad('اسم القناة مطلوب (60 حرف بحد أقصى)');
  if (!COLOR_RE.test(color)) throw bad('اللون لازم يكون بصيغة #RRGGBB');
  if (typeof style !== 'string' || style.length > 1000) throw bad('وصف أسلوب القناة طويل أوي');
  if (typeof title_prompt !== 'string' || title_prompt.length > 5000 || typeof image_prompt !== 'string' || image_prompt.length > 5000) throw bad('برومبت القناة طويل أوي');
  const pos = num(db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM channels').get().p);
  const r = db.prepare('INSERT INTO channels(name, color, icon, style, title_prompt, image_prompt, position) VALUES(?, ?, ?, ?, ?, ?, ?)').run(name.trim(), color, cleanIcon(icon), style, title_prompt, image_prompt, pos);
  return getChannel(db, num(r.lastInsertRowid));
}

export function getChannel(db, id) {
  const c = db.prepare('SELECT id, name, color, icon, style, title_prompt, image_prompt, position FROM channels WHERE id = ?').get(id);
  return c ? { ...c } : null;
}

export function updateChannel(db, id, patch) {
  const cur = getChannel(db, id);
  if (!cur) return null;
  const next = { ...cur };
  if ('name' in patch) {
    if (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.length > 60) throw bad('اسم القناة مش صح');
    next.name = patch.name.trim();
  }
  if ('color' in patch) {
    if (!COLOR_RE.test(patch.color)) throw bad('اللون لازم يكون بصيغة #RRGGBB');
    next.color = patch.color;
  }
  if ('style' in patch) {
    if (typeof patch.style !== 'string' || patch.style.length > 1000) throw bad('وصف أسلوب القناة طويل أوي');
    next.style = patch.style;
  }
  for (const key of ['title_prompt', 'image_prompt']) {
    if (key in patch) {
      if (typeof patch[key] !== 'string' || patch[key].length > 5000) throw bad('برومبت القناة طويل أوي');
      next[key] = patch[key];
    }
  }
  if ('icon' in patch) next.icon = cleanIcon(patch.icon);
  db.prepare('UPDATE channels SET name = ?, color = ?, icon = ?, style = ?, title_prompt = ?, image_prompt = ? WHERE id = ?').run(next.name, next.color, next.icon, next.style, next.title_prompt, next.image_prompt, id);
  return next;
}

export function deleteChannel(db, id) {
  return num(db.prepare('DELETE FROM channels WHERE id = ?').run(id).changes) > 0;
}

// ───────────── الأسابيع والمهام ─────────────

export function listTemplate(db) {
  return db
    .prepare('SELECT id, channel_id, title, day, is_video, position FROM template_tasks ORDER BY position, id')
    .all()
    .map((t) => ({ ...t, is_video: !!t.is_video }));
}

const validDay = (d) => d === null || d === undefined || isInt(d, 0, 6);

function cleanTemplateTask(t, i) {
  if (typeof t?.title !== 'string' || !t.title.trim() || t.title.length > 300) throw bad(`اسم المهمة رقم ${i + 1} مش صح`);
  if (!validDay(t.day)) throw bad(`يوم المهمة رقم ${i + 1} مش صح`);
  return {
    id: Number.isInteger(t.id) ? t.id : null,
    channel_id: Number.isInteger(t.channel_id) ? t.channel_id : null,
    title: t.title.trim(),
    day: t.day ?? null,
    is_video: t.is_video === false || t.is_video === 0 ? 0 : 1,
  };
}

export function getWeekRow(db, weekStart) {
  return db.prepare('SELECT week_start, target, created_at FROM weeks WHERE week_start = ?').get(weekStart) ?? null;
}

/** بيجهّز أسبوع جديد من قائمة المهام الثابتة (للأسبوع الحالي والجاي بس، مش الماضي) */
export function ensureWeek(db, weekStart, currentWeekStart, target) {
  if (weekStart < currentWeekStart) return;
  if (getWeekRow(db, weekStart)) return;
  const tpl = db.prepare('SELECT * FROM template_tasks ORDER BY position, id').all();
  tx(db, () => {
    db.prepare('INSERT INTO weeks(week_start, target, created_at) VALUES(?, ?, ?)').run(weekStart, target, new Date().toISOString());
    const ins = db.prepare(
      'INSERT INTO entries(week_start, template_id, channel_id, title, day, is_video, position) VALUES(?, ?, ?, ?, ?, ?, ?)',
    );
    tpl.forEach((t, i) => ins.run(weekStart, t.id, t.channel_id, t.title, t.day, t.is_video, i));
  });
}

export function serializeEntry(row, channelsById) {
  const channel = row.channel_id ? channelsById.get(row.channel_id) ?? null : null;
  const base = {
    id: num(row.id),
    week_start: row.week_start,
    template_id: row.template_id,
    channel_id: row.channel_id,
    channel,
    title: row.title,
    day: row.day,
    is_video: !!row.is_video,
    position: row.position,
    done: !!row.done,
    done_at: row.done_at,
    uploaded_at: row.uploaded_at,
    upload_platforms: JSON.parse(row.upload_platforms || '[]'),
    script: row.script,
    script_ready: !!row.script_ready,
    notes: row.notes,
    titles: JSON.parse(row.titles || '[]'),
    chosen_title: row.chosen_title,
    thumb_prompt: row.thumb_prompt,
    thumb_url: row.thumb_file ? `/thumbs/${row.thumb_file}` : null,
  };
  base.suggested_thumb_prompt = buildThumbnailPrompt({
    title: row.chosen_title || row.title,
    channel,
    script: row.script,
  });
  return base;
}

export function listEntries(db, weekStart) {
  const channelsById = new Map(listChannels(db).map((c) => [c.id, c]));
  return db
    .prepare('SELECT * FROM entries WHERE week_start = ? ORDER BY position, id')
    .all(weekStart)
    .map((r) => serializeEntry(r, channelsById));
}

export function getEntryRow(db, id) {
  return db.prepare('SELECT * FROM entries WHERE id = ?').get(id) ?? null;
}

export function getEntry(db, id) {
  const row = getEntryRow(db, id);
  if (!row) return null;
  const channelsById = new Map(listChannels(db).map((c) => [c.id, c]));
  return serializeEntry(row, channelsById);
}

export function addEntry(db, weekStart, body) {
  if (typeof body?.title !== 'string' || !body.title.trim() || body.title.length > 300) throw bad('اسم المهمة مطلوب');
  if (!validDay(body.day)) throw bad('اليوم مش صح');
  const channelId = Number.isInteger(body.channel_id) && getChannel(db, body.channel_id) ? body.channel_id : null;
  const pos = num(db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM entries WHERE week_start = ?').get(weekStart).p);
  const r = db
    .prepare('INSERT INTO entries(week_start, template_id, channel_id, title, day, is_video, position) VALUES(?, NULL, ?, ?, ?, ?, ?)')
    .run(weekStart, channelId, body.title.trim(), body.day ?? null, body.is_video === false ? 0 : 1, pos);
  return getEntry(db, num(r.lastInsertRowid));
}

const TEXT_LIMIT = 200_000;

/** تعديل جزئي لمهمة. بيرجّع المهمة بعد التعديل */
export function patchEntry(db, id, patch) {
  const row = getEntryRow(db, id);
  if (!row) return null;
  const set = {};
  const text = (k, max = TEXT_LIMIT) => {
    if (typeof patch[k] !== 'string' || patch[k].length > max) throw bad(`الحقل ${k} مش صح أو طويل أوي`);
    set[k] = patch[k];
  };
  if ('script' in patch) text('script');
  if ('notes' in patch) text('notes');
  if ('thumb_prompt' in patch) text('thumb_prompt', 5000);
  if ('chosen_title' in patch) text('chosen_title', 300);
  if ('title' in patch) {
    if (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > 300) throw bad('اسم المهمة مش صح');
    set.title = patch.title.trim();
  }
  if ('channel_id' in patch) {
    if (patch.channel_id !== null && !(Number.isInteger(patch.channel_id) && getChannel(db, patch.channel_id))) throw bad('القناة مش موجودة');
    set.channel_id = patch.channel_id;
  }
  if ('day' in patch) {
    if (!validDay(patch.day)) throw bad('اليوم مش صح');
    set.day = patch.day ?? null;
  }
  if ('is_video' in patch) set.is_video = patch.is_video ? 1 : 0;
  if ('script_ready' in patch) set.script_ready = patch.script_ready ? 1 : 0;
  if ('done' in patch) {
    set.done = patch.done ? 1 : 0;
    set.done_at = patch.done ? row.done_at ?? new Date().toISOString() : null;
    // لو شلت علامة "تم"، الرفع بيتلغي كمان (الرفع معناه إن الفيديو خلص)
    if (!patch.done) {
      set.uploaded_at = null;
      set.upload_platforms = '[]';
    }
  }
  const keys = Object.keys(set);
  if (keys.length) {
    db.prepare(`UPDATE entries SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), id);
  }
  return getEntry(db, id);
}

export function markUploaded(db, id, platforms, allowed) {
  const row = getEntryRow(db, id);
  if (!row) return null;
  const list = Array.isArray(platforms) ? [...new Set(platforms.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()))] : [];
  if (list.some((p) => !allowed.includes(p))) throw bad('منصة مش موجودة في قائمة المنصات');
  const now = new Date().toISOString();
  db.prepare('UPDATE entries SET done = 1, done_at = COALESCE(done_at, ?), uploaded_at = ?, upload_platforms = ? WHERE id = ?').run(
    now,
    now,
    JSON.stringify(list),
    id,
  );
  return getEntry(db, id);
}

export function undoUpload(db, id) {
  if (!getEntryRow(db, id)) return null;
  db.prepare("UPDATE entries SET uploaded_at = NULL, upload_platforms = '[]' WHERE id = ?").run(id);
  return getEntry(db, id);
}

export function deleteEntry(db, id) {
  const row = getEntryRow(db, id);
  if (!row) return null;
  db.prepare('DELETE FROM entries WHERE id = ?').run(id);
  return row;
}

export function saveTitles(db, id, titles) {
  db.prepare('UPDATE entries SET titles = ? WHERE id = ?').run(JSON.stringify(titles), id);
}

export function saveThumbnail(db, id, file, prompt) {
  db.prepare('UPDATE entries SET thumb_file = ?, thumb_prompt = ? WHERE id = ?').run(file, prompt, id);
}

/**
 * استبدال قائمة المهام الثابتة بالكامل، وتطبيقها على الأسبوع الحالي:
 * - مهمة جديدة → بتتضاف للأسبوع الحالي.
 * - مهمة اتعدلت → بتتعدل في الأسبوع الحالي لو لسه مخلصتش.
 * - مهمة اتحذفت → بتتشال من الأسبوع الحالي لو فاضية، وإلا بتفضل كمهمة إضافية (عشان متضيعش شغلك).
 */
export function replaceTemplate(db, tasks, currentWeekStart, target) {
  if (!Array.isArray(tasks) || tasks.length > 200) throw bad('قائمة المهام مش صح');
  const clean = tasks.map(cleanTemplateTask);
  ensureWeek(db, currentWeekStart, currentWeekStart, target);
  tx(db, () => {
    const channelOk = (id) => (id && getChannel(db, id) ? id : null);
    const existing = new Set(db.prepare('SELECT id FROM template_tasks').all().map((r) => num(r.id)));
    const keep = new Set();
    clean.forEach((t, i) => {
      const ch = channelOk(t.channel_id);
      let id = t.id && existing.has(t.id) ? t.id : null;
      if (id) {
        db.prepare('UPDATE template_tasks SET channel_id = ?, title = ?, day = ?, is_video = ?, position = ? WHERE id = ?').run(
          ch, t.title, t.day, t.is_video, i, id,
        );
      } else {
        id = num(
          db
            .prepare('INSERT INTO template_tasks(channel_id, title, day, is_video, position) VALUES(?, ?, ?, ?, ?)')
            .run(ch, t.title, t.day, t.is_video, i).lastInsertRowid,
        );
      }
      keep.add(id);
      const entry = db.prepare('SELECT id, done FROM entries WHERE week_start = ? AND template_id = ?').get(currentWeekStart, id);
      if (!entry) {
        db.prepare(
          'INSERT INTO entries(week_start, template_id, channel_id, title, day, is_video, position) VALUES(?, ?, ?, ?, ?, ?, ?)',
        ).run(currentWeekStart, id, ch, t.title, t.day, t.is_video, i);
      } else if (!entry.done) {
        db.prepare('UPDATE entries SET channel_id = ?, title = ?, day = ?, is_video = ?, position = ? WHERE id = ?').run(
          ch, t.title, t.day, t.is_video, i, entry.id,
        );
      }
    });
    for (const id of existing) {
      if (keep.has(id)) continue;
      db.prepare('DELETE FROM template_tasks WHERE id = ?').run(id);
      const e = db.prepare('SELECT id, done, script, notes FROM entries WHERE week_start = ? AND template_id = ?').get(currentWeekStart, id);
      if (e) {
        if (!e.done && !e.script && !e.notes) db.prepare('DELETE FROM entries WHERE id = ?').run(e.id);
        else db.prepare('UPDATE entries SET template_id = NULL WHERE id = ?').run(e.id);
      }
    }
  });
  return listTemplate(db);
}

// ───────────── السجل والالتزام الشهري ─────────────

export function weeksHistory(db, limit = 26) {
  const rows = db
    .prepare(
      `SELECT w.week_start, w.target,
              COALESCE(SUM(CASE WHEN e.is_video = 1 THEN 1 ELSE 0 END), 0) AS videos,
              COALESCE(SUM(CASE WHEN e.is_video = 1 AND e.done = 1 THEN 1 ELSE 0 END), 0) AS done,
              COALESCE(SUM(CASE WHEN e.is_video = 1 AND e.uploaded_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS uploaded
       FROM weeks w LEFT JOIN entries e ON e.week_start = w.week_start
       GROUP BY w.week_start ORDER BY w.week_start DESC LIMIT ?`,
    )
    .all(limit);
  return rows.map((r) => {
    const done = num(r.done);
    const target = num(r.target);
    return {
      week_start: r.week_start,
      target,
      videos: num(r.videos),
      done,
      uploaded: num(r.uploaded),
      percent: target > 0 ? Math.min(100, Math.floor((done / target) * 100)) : 0,
      bonus: Math.max(0, done - target),
    };
  });
}

/** الالتزام الشهري لكل قناة = المنجز ÷ المخطط في أسابيع الشهر (من غير البونص) */
export function monthlyCommitment(db, from, to) {
  const rows = db
    .prepare(
      `SELECT channel_id, COUNT(*) AS planned, SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END) AS done
       FROM entries WHERE is_video = 1 AND week_start >= ? AND week_start < ?
       GROUP BY channel_id`,
    )
    .all(from, to);
  const channels = new Map(listChannels(db).map((c) => [c.id, c]));
  return rows
    .map((r) => {
      const planned = num(r.planned);
      const done = num(r.done);
      const ch = r.channel_id ? channels.get(r.channel_id) : null;
      return {
        channel_id: r.channel_id,
        name: ch?.name ?? 'من غير قناة',
        color: ch?.color ?? '#8a94a6',
        planned,
        done,
        percent: planned ? Math.min(100, Math.floor((done / planned) * 100)) : 0,
      };
    })
    .sort((a, b) => (a.channel_id ?? 1e9) - (b.channel_id ?? 1e9));
}

export function listResetLog(db, limit = 20) {
  return db.prepare('SELECT week_start, done, target, at FROM reset_log ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({ ...r }));
}

/** تصفير الأسبوع الحالي: بيسجّل النتيجة في السجل وبعدين يبدأ الأسبوع من الأول من قائمة المهام */
export function resetWeek(db, weekStart, currentWeekStart, target) {
  const files = db.prepare("SELECT thumb_file FROM entries WHERE week_start = ? AND thumb_file != ''").all(weekStart).map((r) => r.thumb_file);
  tx(db, () => {
    const done = num(
      db.prepare('SELECT COUNT(*) AS c FROM entries WHERE week_start = ? AND is_video = 1 AND done = 1').get(weekStart).c,
    );
    db.prepare('INSERT INTO reset_log(week_start, done, target, at) VALUES(?, ?, ?, ?)').run(weekStart, done, target, new Date().toISOString());
    db.prepare('DELETE FROM entries WHERE week_start = ?').run(weekStart);
    db.prepare('DELETE FROM weeks WHERE week_start = ?').run(weekStart);
  });
  ensureWeek(db, weekStart, currentWeekStart, target);
  return files;
}

// ───────────── اشتراكات الإشعارات ─────────────

export function savePushSubscription(db, sub) {
  if (typeof sub?.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw bad('اشتراك الإشعارات مش صح');
  }
  db.prepare(
    'INSERT INTO push_subscriptions(endpoint, data, created_at) VALUES(?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET data = excluded.data',
  ).run(sub.endpoint, JSON.stringify(sub), new Date().toISOString());
}

export const removePushSubscription = (db, endpoint) => db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
export const listPushSubscriptions = (db) => db.prepare('SELECT data FROM push_subscriptions').all().map((r) => JSON.parse(r.data));
export const countPushSubscriptions = (db) => num(db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions').get().c);

// ───────────── مخزن السكريبتات (سكريبتات مكتوبة لسه متوزعتش على مهام) ─────────────

export function listBank(db) {
  return db.prepare('SELECT id, title, body, created_at FROM script_bank ORDER BY id DESC').all().map((r) => ({ ...r, id: num(r.id) }));
}

export function getBank(db, id) {
  const r = db.prepare('SELECT id, title, body, created_at FROM script_bank WHERE id = ?').get(id);
  return r ? { ...r, id: num(r.id) } : null;
}

function cleanBankText(v, key, max) {
  if (typeof v !== 'string' || v.length > max) throw bad(`الحقل ${key} مش صح أو طويل أوي`);
  return v;
}

export function createBank(db, { title = '', body = '' } = {}) {
  const t = cleanBankText(title, 'title', 300).trim();
  const b = cleanBankText(body, 'body', TEXT_LIMIT);
  if (!t && !b.trim()) throw bad('اكتب عنوان أو سكريبت الأول');
  const r = db.prepare('INSERT INTO script_bank(title, body, created_at) VALUES(?, ?, ?)').run(t, b, new Date().toISOString());
  return getBank(db, num(r.lastInsertRowid));
}

export function patchBank(db, id, patch) {
  const cur = getBank(db, id);
  if (!cur) return null;
  const next = { ...cur };
  if ('title' in patch) next.title = cleanBankText(patch.title, 'title', 300).trim();
  if ('body' in patch) next.body = cleanBankText(patch.body, 'body', TEXT_LIMIT);
  db.prepare('UPDATE script_bank SET title = ?, body = ? WHERE id = ?').run(next.title, next.body, id);
  return next;
}

export const deleteBank = (db, id) => num(db.prepare('DELETE FROM script_bank WHERE id = ?').run(id).changes) > 0;

/** بيوزّع سكريبت من المخزن على مهمة: بيحطه في خانة السكريبت (كمسودة، مش جاهز) وبيشيله من المخزن */
export function assignBank(db, id, entryId, overwrite = false) {
  const item = getBank(db, id);
  if (!item) return { missing: 'bank' };
  const row = getEntryRow(db, entryId);
  if (!row) return { missing: 'entry' };
  if (row.script.trim() && !overwrite) throw new AppError(409, 'المهمة دي فيها سكريبت أصلًا. أكّد الاستبدال لو عايز.');
  tx(db, () => {
    db.prepare('UPDATE entries SET script = ?, script_ready = 0 WHERE id = ?').run(item.body, entryId);
    db.prepare('DELETE FROM script_bank WHERE id = ?').run(id);
  });
  return { entry: getEntry(db, entryId) };
}
