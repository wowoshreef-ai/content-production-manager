import { dayOffset } from './dates.js';

/**
 * حساب إنجاز الأسبوع.
 * - بيتحسب بس الفيديوهات (is_video) اللي اتعلّمت "تم".
 * - الوصول لـ target (18 افتراضيًا) = 100% = أسبوع كامل.
 * - أي فيديو زيادة عن الهدف = بونص (الـ % بتفضل 100 والبونص بيتعدّ لوحده).
 */
export function computeProgress(entries, target) {
  const videos = entries.filter((e) => e.is_video);
  const others = entries.filter((e) => !e.is_video);
  const done = videos.filter((e) => e.done).length;
  const uploaded = videos.filter((e) => e.uploaded_at).length;
  const percent = target > 0 ? Math.min(100, Math.floor((done / target) * 100)) : 0;
  return {
    target,
    done,
    uploaded,
    totalVideos: videos.length,
    percent,
    bonus: Math.max(0, done - target),
    remaining: Math.max(0, target - done),
    complete: target > 0 && done >= target,
    otherDone: others.filter((e) => e.done).length,
    otherTotal: others.length,
  };
}

/** المهام اللي لسه مخلصتش وميعادها النهاردة أو فات (أو من غير يوم محدد) */
export function pendingForToday(entries, todayWeekday, startDay) {
  const today = dayOffset(todayWeekday, startDay);
  return entries.filter((e) => !e.done && (e.day === null || dayOffset(e.day, startDay) <= today));
}

export function arTasks(n) {
  if (n === 1) return 'مهمة واحدة';
  if (n === 2) return 'مهمتين';
  if (n <= 10) return `${n} مهام`;
  return `${n} مهمة`;
}

/** نص إشعار التذكير اليومي، أو null لو مفيش حاجة متأخرة */
export function buildReminder({ entries, progress, todayWeekday, startDay }) {
  const pending = pendingForToday(entries, todayWeekday, startDay);
  if (!pending.length) return null;
  const lines = pending.slice(0, 4).map((e) => `• ${e.channel?.name ? `${e.channel.name}: ` : ''}${e.title}`);
  if (pending.length > 4) lines.push(`… و${pending.length - 4} كمان`);
  lines.push(`إنجاز الأسبوع: ${progress.done}/${progress.target}`);
  return {
    title: `📌 عندك ${arTasks(pending.length)} النهاردة`,
    body: lines.join('\n'),
    tag: 'daily-reminder',
    url: '/',
  };
}
