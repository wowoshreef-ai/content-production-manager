import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dayOffset, monthRange, weekStartFor, zonedParts } from '../server/dates.js';
import { buildReminder, computeProgress, pendingForToday } from '../server/progress.js';
import { buildThumbnailPrompt, parseTitles, pickProvider } from '../server/ai.js';

const entries = (n, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, is_video: true, done: false, uploaded_at: null, day: null, title: `فيديو ${i + 1}`, channel: null, ...extra }));

test('بداية الأسبوع (السبت) بتتحسب صح', () => {
  assert.equal(weekStartFor('2026-10-27', 6), '2026-10-24');
  assert.equal(weekStartFor('2026-10-24', 6), '2026-10-24');
  assert.equal(weekStartFor('2026-10-23', 6), '2026-10-17');
  assert.equal(weekStartFor('2026-10-27', 1), '2026-10-26'); // لو الأسبوع بيبدأ الاثنين
});

test('التوقيت المحلي: 22:30 UTC بيبقى اليوم اللي بعده في القاهرة', () => {
  const p = zonedParts(new Date('2026-10-27T22:30:00Z'), 'Africa/Cairo');
  assert.equal(p.date, '2026-10-28');
  assert.equal(p.weekday, 3); // الأربعاء
});

test('addDays / dayOffset / monthRange', () => {
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(dayOffset(6, 6), 0);
  assert.equal(dayOffset(0, 6), 1);
  assert.deepEqual(monthRange('2026-12-15'), { from: '2026-12-01', to: '2027-01-01' });
});

test('18 فيديو = 100% والأسبوع كامل من غير بونص', () => {
  const p = computeProgress(entries(18, { done: true }), 18);
  assert.equal(p.percent, 100);
  assert.equal(p.bonus, 0);
  assert.equal(p.complete, true);
});

test('أكتر من 18 فيديو: النسبة تثبت 100% والزيادة بونص', () => {
  const p = computeProgress(entries(21, { done: true }), 18);
  assert.equal(p.percent, 100);
  assert.equal(p.bonus, 3);
  assert.equal(p.remaining, 0);
});

test('نص الهدف = 50% ومن غير تقريب لفوق (17 من 18 مش 100%)', () => {
  assert.equal(computeProgress(entries(9, { done: true }), 18).percent, 50);
  const p17 = computeProgress(entries(17, { done: true }), 18);
  assert.equal(p17.percent, 94);
  assert.equal(p17.complete, false);
});

test('المهام العادية (مش فيديو) مش بتتحسب في الهدف', () => {
  const list = [...entries(3, { done: true }), { id: 99, is_video: false, done: true, uploaded_at: null }];
  const p = computeProgress(list, 18);
  assert.equal(p.done, 3);
  assert.equal(p.otherDone, 1);
});

test('التذكير: بيشمل المتأخر وميعاد النهاردة ومن غير يوم، ومش بيشمل الأيام الجاية', () => {
  // الأسبوع بيبدأ السبت (6). النهاردة الثلاثاء (2) → offset 3
  const list = [
    { ...entries(1)[0], id: 1, day: 6, title: 'متأخر' }, // السبت
    { ...entries(1)[0], id: 2, day: 2, title: 'النهاردة' },
    { ...entries(1)[0], id: 3, day: 4, title: 'الخميس' }, // لسه
    { ...entries(1)[0], id: 4, day: null, title: 'أي يوم' },
    { ...entries(1)[0], id: 5, day: 2, done: true, title: 'خلصان' },
  ];
  const titles = pendingForToday(list, 2, 6).map((e) => e.title);
  assert.deepEqual(titles.sort(), ['أي يوم', 'متأخر', 'النهاردة'].sort());
  const r = buildReminder({ entries: list, progress: computeProgress(list, 18), todayWeekday: 2, startDay: 6 });
  assert.match(r.title, /3 مهام/);
  assert.match(r.body, /إنجاز الأسبوع: 1\/18/);
  assert.equal(buildReminder({ entries: [], progress: computeProgress([], 18), todayWeekday: 2, startDay: 6 }), null);
});

test('parseTitles: JSON وقوائم نصية', () => {
  assert.deepEqual(parseTitles('هاك:\n["عنوان 1", "عنوان 2", "عنوان 1"]'), ['عنوان 1', 'عنوان 2']);
  assert.deepEqual(parseTitles('1. أول عنوان\n2) تاني عنوان\n- "تالت عنوان"'), ['أول عنوان', 'تاني عنوان', 'تالت عنوان']);
  assert.equal(parseTitles('["a","b","c","d","e","f","g"]', 3).length, 3);
});

test('pickProvider: بيرفض مزوّد من غير مفتاح ويختار المتاح تلقائيًا', () => {
  assert.throws(() => pickProvider({}, 'auto'), /\.env/);
  assert.throws(() => pickProvider({ GEMINI_API_KEY: 'x' }, 'anthropic'), /anthropic/);
  assert.equal(pickProvider({ GEMINI_API_KEY: 'x' }, 'auto'), 'gemini');
  assert.equal(pickProvider({ GEMINI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y', AI_PROVIDER: 'gemini' }, 'auto'), 'gemini');
});

test('برومبت الصورة المصغرة بيحتوي العنوان وأسلوب القناة', () => {
  const p = buildThumbnailPrompt({ title: 'الروبوت ده هياخد شغلك', channel: { name: 'القيادي', style: 'تقني' }, script: '' });
  assert.match(p, /الروبوت ده هياخد شغلك/);
  assert.match(p, /القيادي/);
  assert.match(p, /تقني/);
});
