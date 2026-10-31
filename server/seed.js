import { createChannel, listChannels, setMeta, getMeta, tx, updateSettings } from './store.js';

// ⚠️ بيانات تجريبية بالكامل — مش منقولة من الموقع القديم. عدّلها أو امسحها من الإعدادات.
const DEMO_CHANNELS = [
  { name: 'القيادي', color: '#4f8cff', style: 'تقنية وذكاء اصطناعي. ذكي وبسيط، سريع، واثق، فيه لمسة درامية. الجمهور عايز يحس إنه فاهم المستقبل قبل الكل.' },
  { name: 'رائج', color: '#ff6b6b', style: 'تريندات وأحداث الإنترنت. سريع جدًا، مليان ميمز وصدمة، والجمهور عايز يبعت الفيديو لحد.' },
  { name: 'عرب جيمرز', color: '#9b6bff', style: 'ألعاب وهايب. حماس وطاقة، يوري أقوى حاجة في اللعبة من أول ثانية.' },
  { name: 'سائح', color: '#2ec4b6', style: 'سفر وأماكن غريبة. سينمائي وهادي ومبهر، والجمهور يحس إنه نفسه يروح هناك.' },
];

// عدد فيديوهات كل قناة في الأسبوع التجريبي (المجموع 18)
const PER_CHANNEL = [5, 5, 4, 4];
// أيام الأسبوع التجريبية (السبت أول يوم): 6,0,1,2,3,4
const DAYS = [6, 0, 1, 2, 3, 4];

export function seedDemo(db) {
  if (listChannels(db).length || getMeta(db, 'seeded')) return false;
  tx(db, () => {
    const channels = DEMO_CHANNELS.map((c) => createChannel(db, c));
    const ins = db.prepare('INSERT INTO template_tasks(channel_id, title, day, is_video, position) VALUES(?, ?, ?, 1, ?)');
    let pos = 0;
    channels.forEach((ch, ci) => {
      for (let i = 0; i < PER_CHANNEL[ci]; i++) {
        ins.run(ch.id, `فيديو ${i + 1} — ${ch.name} (تجريبي)`, DAYS[pos % DAYS.length], pos);
        pos++;
      }
    });
    setMeta(db, 'seeded', true);
    setMeta(db, 'demo', true);
  });
  return true;
}

// ───────────── الجدول الحقيقي (منقول من الموقع القديم) ─────────────
// 4 قنوات × 6 أيام (الجمعة → الأربعاء)، 4 مهام كل يوم = 24 مهمة. الهدف الأسبوعي 18 والباقي بونص.
const BRAND = {
  'القيادي': { color: '#4c7cff', icon: '⚡', style: 'تقنية وذكاء اصطناعي. ذكي وبسيط، سريع، واثق، فيه لمسة درامية. الجمهور عايز يحس إنه فاهم المستقبل قبل الكل.' },
  'رائج': { color: '#ff3d68', icon: '🔥', style: 'تريندات وأحداث الإنترنت. سريع جدًا، مليان ميمز وصدمة، والجمهور عايز يبعت الفيديو لحد.' },
  'عرب جيمرز': { color: '#a855f7', icon: '🎮', style: 'ألعاب وهايب. حماس وطاقة، يوري أقوى حاجة في اللعبة من أول ثانية.' },
  'سائح': { color: '#14c8b0', icon: '✈️', style: 'سفر وأماكن غريبة. سينمائي وهادي ومبهر، والجمهور يحس إنه نفسه يروح هناك.' },
};
const GAME = ['عرب جيمرز', 'فيديو جيمنج'];
const TRAVEL = ['سائح', 'فيديو سياحي'];
const DAILY = [['القيادي', 'فيديو 1'], ['القيادي', 'فيديو 2'], ['رائج', 'فيديو ترند']];
// [يوم الأسبوع (0 = الأحد)، المهمة الرابعة]
const PLAN = [[5, GAME], [6, TRAVEL], [0, GAME], [1, TRAVEL], [2, GAME], [3, TRAVEL]];

export function seedDefaultWeek(db) {
  if (listChannels(db).length || getMeta(db, 'seeded')) return false;
  tx(db, () => {
    const ids = new Map(Object.entries(BRAND).map(([name, b]) => [name, createChannel(db, { name, ...b }).id]));
    const ins = db.prepare('INSERT INTO template_tasks(channel_id, title, day, is_video, position) VALUES(?, ?, ?, 1, ?)');
    let pos = 0;
    for (const [day, fourth] of PLAN) {
      for (const [channel, title] of [...DAILY, fourth]) ins.run(ids.get(channel), title, day, pos++);
    }
    setMeta(db, 'seeded', true);
  });
  updateSettings(db, { weekStartDay: 5, workDays: [5, 6, 0, 1, 2, 3] });
  return true;
}
