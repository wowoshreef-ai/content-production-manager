import { zonedParts, weekStartFor } from './dates.js';
import { ensureWeek, getMeta, getSettings, listEntries, setMeta, countPushSubscriptions } from './store.js';
import { buildReminder, computeProgress } from './progress.js';

/**
 * بيفحص لو جه وقت التذكير اليومي وبيبعت إشعار مرة واحدة في اليوم.
 * - بيتبعت بس في أيام الشغل، وبس لو فيه مهام متأخرة أو ميعادها النهاردة.
 * - لو السيرفر اشتغل متأخر عن الميعاد، الإشعار بيتبعت أول ما يشتغل (مرة واحدة في اليوم).
 */
export async function runReminderCheck({ db, push, now = () => new Date(), force = false }) {
  const s = getSettings(db);
  if (!force && !s.reminderEnabled) return { sent: 0, reason: 'disabled' };

  const p = zonedParts(now(), s.timezone);
  if (!force) {
    if (!s.workDays.includes(p.weekday)) return { sent: 0, reason: 'not-a-work-day' };
    if (p.time < s.reminderTime) return { sent: 0, reason: 'too-early' };
    if (getMeta(db, 'lastReminderDate') === p.date) return { sent: 0, reason: 'already-sent' };
  }
  if (countPushSubscriptions(db) === 0) return { sent: 0, reason: 'no-subscribers' };

  const weekStart = weekStartFor(p.date, s.weekStartDay);
  ensureWeek(db, weekStart, weekStart, s.weeklyTarget);
  const entries = listEntries(db, weekStart);
  const progress = computeProgress(entries, s.weeklyTarget);
  const payload = buildReminder({ entries, progress, todayWeekday: p.weekday, startDay: s.weekStartDay });
  if (!payload) {
    if (!force) setMeta(db, 'lastReminderDate', p.date);
    return { sent: 0, reason: 'nothing-pending' };
  }
  const result = await push.sendAll(payload);
  if (!force && result.sent > 0) setMeta(db, 'lastReminderDate', p.date);
  return { ...result, reason: result.sent > 0 ? 'sent' : 'delivery-failed' };
}

export function startScheduler({ db, push, intervalMs = 30_000, log = console }) {
  const tick = () =>
    runReminderCheck({ db, push }).catch((e) => log.error('[reminder] فشل فحص التذكير:', e.message));
  tick();
  const t = setInterval(tick, intervalMs);
  t.unref?.();
  return () => clearInterval(t);
}
