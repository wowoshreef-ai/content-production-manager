// أدوات التواريخ: كل حاجة بتتحسب بتوقيت المستخدم (TZ) مش توقيت السيرفر.

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

/** يرجّع { date: 'YYYY-MM-DD', time: 'HH:MM', weekday: 0..6 (0 = الأحد) } بتوقيت tz */
export function zonedParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    weekday: WD[p.weekday],
  };
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/** أول يوم في الأسبوع اللي بيحتوي dateStr، حسب يوم بداية الأسبوع startDay */
export function weekStartFor(dateStr, startDay) {
  const diff = (weekdayOf(dateStr) - startDay + 7) % 7;
  return addDays(dateStr, -diff);
}

/** ترتيب اليوم جوه الأسبوع (0 = أول يوم) */
export function dayOffset(weekday, startDay) {
  return (weekday - startDay + 7) % 7;
}

/** حدود الشهر اللي فيه dateStr: from (شامل) و to (غير شامل) */
export function monthRange(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const to = `${ny}-${String(nm).padStart(2, '0')}-01`;
  return { from, to };
}
