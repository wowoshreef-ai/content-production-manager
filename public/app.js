import { createApiClient } from './api-client.js';

'use strict';

const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const state = {
  data: null,
  open: new Set(),
  sDay: null, // اليوم المختار في صفحة السكريبتات
  bank: [], // مخزن السكريبتات
  busy: new Set(),
  provider: '', // مزوّد الذكاء الاصطناعي المختار للعناوين
  modal: null,
  history: null,
  viewWeek: null,
  returnHash: '#/today',
};

// ───────────── أدوات عامة ─────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isErr ? 5000 : 2600);
}

function setOnline(on) {
  $('#status')?.classList.toggle('off', !on);
  const t = $('#statusText');
  if (t) t.textContent = on ? 'أونلاين' : 'مفيش اتصال';
}

const api = createApiClient({ onConnectionChange: setOnline });

function addDaysStr(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const fmtDay = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const fmtRange = (ws) => `${fmtDay(ws)} ← ${fmtDay(addDaysStr(ws, 6))}`;
const fmtDateTime = (iso) => new Date(iso).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
const entryById = (id) => state.data.entries.find((e) => e.id === id);

function replaceEntry(entry) {
  const i = state.data.entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) state.data.entries[i] = entry;
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}
const autosizeAll = (root = document) => $$('textarea.auto', root).forEach(autosize);

function linksFrom(text) {
  return (String(text).match(/https?:\/\/[^\s<>"']+/g) || []).map((u) => u.replace(/[.,;:!?)\]،؛]+$/, ''));
}
const linksHtml = (text) =>
  linksFrom(text)
    .map((u) => `<li>🔗 <a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a></li>`)
    .join('');

// ───────────── الحفظ التلقائي ─────────────
const pending = new Map(); // "kind:id:field" → { kind, id, field, value, timer } (kind: entries | bank)
let savedTimer;

function showSaved(text) {
  const el = $('#saveState');
  el.textContent = text;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (el.textContent = ''), 2000);
}

function scheduleSave(id, field, value, kind = 'entries') {
  const key = `${kind}:${id}:${field}`;
  clearTimeout(pending.get(key)?.timer);
  const item = { kind, id, field, value, timer: null };
  item.timer = setTimeout(() => flushOne(key), 700);
  pending.set(key, item);
  showSaved('⏳ بيحفظ…');
}

async function flushOne(key, keepalive = false) {
  const item = pending.get(key);
  if (!item) return;
  clearTimeout(item.timer);
  pending.delete(key);
  try {
    await api(`/${item.kind}/${item.id}`, { method: 'PATCH', body: { [item.field]: item.value }, keepalive });
    showSaved('اتحفظ ✓');
  } catch (e) {
    toast(`ما اتحفظش: ${e.message}`, true);
  }
}
const flushAll = (keepalive = false) => Promise.all([...pending.keys()].map((k) => flushOne(k, keepalive)));

// ───────────── تحميل الحالة ─────────────
async function load() {
  await flushAll();
  const query = state.viewWeek ? `?week=${encodeURIComponent(state.viewWeek)}` : '';
  const data = await api(`/state${query}`);
  const [bank, history] = await Promise.all([api('/bank'), api('/history')]);
  state.data = data;
  state.bank = bank;
  state.history = history;
  render();
}

// ───────────── الرسم ─────────────
function captureFocus() {
  const a = document.activeElement;
  if (a && a.dataset && a.dataset.field && a.dataset.id) {
    return { id: a.dataset.id, field: a.dataset.field, s: a.selectionStart, e: a.selectionEnd };
  }
  return null;
}
function restoreFocus(snap) {
  if (!snap) return;
  const el = $(`[data-id="${snap.id}"][data-field="${snap.field}"]`);
  if (!el) return;
  el.focus();
  try {
    if (snap.s != null) el.setSelectionRange(snap.s, snap.e);
  } catch {
    /* مش كل العناصر بتدعم ده */
  }
}

const chLabel = (c) => `${c.icon ? `${esc(c.icon)} ` : ''}${esc(c.name)}`;
const hasScript = (e) => !!(e.script && e.script.trim());
const hasNotes = (e) => !!(e.notes && e.notes.trim());
const scriptFlag = (e) => `<span class="flag written" data-sflag="${e.id}"${hasScript(e) ? '' : ' hidden'}>✅ تم كتابة السكريبت</span>`;
const noteFlag = (e) => `<span class="flag written" data-nflag="${e.id}"${hasNotes(e) && !hasScript(e) ? '' : ' hidden'}>💡 الفكرة جاهزة</span>`;
function proofreadButton(e) {
  const busy = state.busy.has('p' + e.id);
  const ready = state.data?.integrations?.aiProviders?.includes('gemini');
  const disabled = busy || !hasScript(e) || !ready;
  const label = busy ? '⏳ جارٍ التدقيق…' : '✓ تدقيق إملائي';
  const title = ready ? 'تصحيح الإملاء فقط مع الحفاظ على صياغة النص' : 'أضف مفتاح Gemini لتفعيل التدقيق';
  return '<button class="btn small ghost proofread-btn" data-act="proofread" data-id="' + e.id + '" type="button" title="' + title + '" aria-label="' + title + '" ' + (disabled ? 'disabled' : '') + '>' + label + '</button>';
}

const pageIs = () => {
  const route = location.hash.replace(/^#\//, '');
  if (route === 'settings') return state.returnHash.replace(/^#\//, '') || 'today';
  return ['today', 'week', 'history', 'scripts'].includes(route) ? route : 'today';
};

function render() {
  const d = state.data;
  if (!d) return;
  const snap = captureFocus();
  const page = pageIs();
  $('#subtitle').textContent = d.channels.length ? d.channels.map((c) => c.name).join(' · ') : 'ضيف قنواتك من الإعدادات';
  $('#headerWeekLabel').textContent = `الأسبوع · ${fmtRange(d.weekStart)}`;
  let dismissed = false;
  try { dismissed = localStorage.getItem('demoDismissed') === '1'; } catch { /* التخزين مش متاح */ }
  $('#demoBanner').hidden = !(d.demo && !dismissed && (page === 'today' || page === 'week'));
  $('#progress').hidden = page !== 'week';
  $$('#pageNav [data-route]').forEach((a) => {
    const active = a.dataset.route === page;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const titles = { today: 'النهارده', week: 'الأسبوع', history: 'السجل والتحليلات', scripts: 'السكريبتات' };
  document.title = `${titles[page]} — مدير إنتاج المحتوى`;
  const keep = { t: $('#bankTitle')?.value, b: $('#bankBody')?.value };
  if (!$('#progress').hidden) renderProgress();
  $('#view').innerHTML = ({ today: todayView, week: weekView, history: historyView, scripts: scriptsView })[page]();
  if (keep.t && $('#bankTitle')) $('#bankTitle').value = keep.t;
  if (keep.b && $('#bankBody')) $('#bankBody').value = keep.b;
  restoreFocus(snap);
  autosizeAll();
}

function renderProgress() {
  const d = state.data;
  const p = d.progress;
  const perChannel = d.channels
    .map((c) => {
      const mine = d.entries.filter((e) => e.is_video && e.channel_id === c.id);
      if (!mine.length) return '';
      return `<span class="chip" style="--c:${esc(c.color)}"><i></i>${chLabel(c)} ${mine.filter((e) => e.done).length}/${mine.length}</span>`;
    })
    .join('');
  const status = p.complete
    ? `🎉 الأسبوع كامل!${p.bonus ? ' وكل فيديو زيادة بونص.' : ''}`
    : `فاضل ${p.remaining} فيديو ويكمل الأسبوع`;
  $('#progress').innerHTML = `
    <div class="ring ${p.complete ? 'complete' : ''}" style="--p:${p.percent}"><span>${p.percent}%</span></div>
    <div>
      <p class="p-range">${fmtRange(d.weekStart)}</p>
      <p class="p-title">${p.done} / ${p.target} فيديو${p.bonus ? `<span class="bonus">+${p.bonus} بونص 🔥</span>` : ''}</p>
      <p class="p-sub">${status} · اترفع ${p.uploaded} · ✍️ سكريبتات مكتوبة ${d.entries.filter((e) => e.is_video && hasScript(e)).length}/${p.totalVideos}${p.otherTotal ? ` · مهام تانية ${p.otherDone}/${p.otherTotal}` : ''}</p>
      <div class="upload-progress" aria-label="تقدم رفع الفيديوهات">
        <div class="upload-progress-label"><span>📤 تقدم الرفع</span><strong>${p.uploaded}/${p.target}</strong></div>
        <div class="upload-progress-track"><i style="width:${p.target ? Math.min(100, Math.floor((p.uploaded / p.target) * 100)) : 0}%"></i></div>
      </div>
      <div class="chips">${perChannel}</div>
    </div>`;
}

function dayGroup(title, small, entries, isToday, isDay = true, wd = null) {
  if (!entries.length && !isToday) return '';
  const complete = isDay && entries.length > 0 && entries.every((e) => e.done);
  const doneN = entries.filter((e) => e.done).length;
  const uploadEntries = entries.filter((e) => e.is_video);
  const uploadedN = uploadEntries.filter((e) => e.uploaded_at).length;
  const allUploaded = isDay && uploadEntries.length > 0 && uploadedN === uploadEntries.length;
  return `<section class="day${isToday ? ' today' : ''}${complete ? ' complete' : ''}${allUploaded ? ' all-uploaded' : ''}"${wd === null ? '' : ` data-wd="${wd}"`}>
    <h3 class="group-title">${title}${isToday ? '<span class="today-tag">النهاردة</span>' : ''}${complete ? '<span class="done-tag">✓ اليوم اكتمل</span>' : ''}${allUploaded ? '<span class="up-tag">📤 اترفع كله</span>' : ''}${small ? ` <small>${small}</small>` : ''}${entries.length ? `<span class="day-bar" title="اكتمل ${doneN} من ${entries.length} · اترفع ${uploadedN} من ${uploadEntries.length}"><i style="width:${Math.round((doneN / entries.length) * 100)}%"></i><b style="width:${(uploadEntries.length ? Math.round((uploadedN / uploadEntries.length) * 100) : 0)}%"></b></span><small class="count">${doneN}/${entries.length}</small>` : ''}</h3>
    ${entries.length ? entries.map(taskCard).join('') : '<div class="empty">مفيش مهام النهاردة 🎉</div>'}
  </section>`;
}

function weekStrip() {
  const d = state.data;
  const nodes = weekOrder()
    .map((wd) => {
      const mine = d.entries.filter((e) => e.day === wd);
      if (!mine.length && wd !== d.todayWeekday) return '';
      const n = mine.filter((e) => e.done).length;
      const cls = mine.length && n === mine.length ? 'done' : n > 0 ? 'partial' : '';
      return `<button class="strip-node${wd === d.todayWeekday ? ' today' : ''}" data-act="strip" data-wd="${wd}" type="button" title="${n}/${mine.length}"><span class="strip-dot ${cls}"></span><span>${DAYS[wd]}</span></button>`;
    })
    .join('');
  return `<nav class="week-strip" aria-label="أيام الأسبوع">${nodes}</nav>`;
}

function weekView() {
  const d = state.data;
  const start = d.settings.weekStartDay;
  let html = `<div class="page-heading"><div><span class="eyebrow">خطة الإنتاج</span><h2>جدول الأسبوع</h2><p>كل المهام ومعدلات الإنجاز لقنواتك</p></div><div class="week-picker"><button class="icon-btn" data-act="week-next" type="button" aria-label="الأسبوع التالي">›</button><strong>${fmtRange(d.weekStart)}</strong><button class="icon-btn" data-act="week-prev" type="button" aria-label="الأسبوع السابق">‹</button></div></div>`;
  html += `<div class="week-legend">${d.channels.map((c) => `<span class="legend-chip"><i style="--channel:${esc(c.color)}"></i>${chLabel(c)}</span>`).join('')}<span class="legend-chip">الكل (${d.progress.totalVideos})</span></div>`;
  html += weekStrip();
  for (let i = 0; i < 7; i++) {
    const wd = (start + i) % 7;
    const mine = d.entries.filter((e) => e.day === wd);
    const off = d.settings.workDays.includes(wd) ? '' : ' · إجازة';
    html += dayGroup(DAYS[wd], fmtDay(addDaysStr(d.weekStart, i)) + off, mine, wd === d.todayWeekday, true, wd);
  }
  html += dayGroup('📋 من غير يوم محدد', '', d.entries.filter((e) => e.day === null), false, false);
  if (!d.entries.length) html += '<div class="empty">مفيش مهام. ضيف مهام من الإعدادات أو أضف فيديو إضافي تحت.</div>';
  html += `<section class="quick-add card"><div><h3>➕ فيديو إضافي للأسبوع</h3><p class="hint">يُضاف كمهمة بونص لهذا الأسبوع</p></div><select id="extraChannel">${d.channels.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><button class="btn" data-act="add-extra" type="button">إضافة</button></section>`;
  html += '<div class="reset-row"><button class="btn ghost" data-act="open-reset" type="button">🔒 إعادة تعيين الجدول بالكامل</button></div>';
  return html;
}

function todayView() {
  const d = state.data;
  const entries = d.entries.filter((e) => e.day === d.todayWeekday);
  const done = entries.filter((e) => e.done).length;
  const uploaded = entries.filter((e) => e.is_video && e.uploaded_at).length;
  const scripts = entries.filter((e) => hasScript(e)).length;
  const dayIndex = (d.todayWeekday - d.settings.weekStartDay + 7) % 7;
  const date = fmtDay(addDaysStr(d.weekStart, dayIndex));
  const channels = d.channels.map((c) => {
    const mine = entries.filter((e) => e.channel_id === c.id);
    if (!mine.length) return '';
    return `<span class="channel-pill"><i style="--channel:${esc(c.color)}"></i>${chLabel(c)} <b>${mine.filter((e) => e.done).length}/${mine.length}</b></span>`;
  }).join('');
  return `<div class="page-heading"><div><span class="eyebrow">مساحة العمل اليومية</span><h2>مهام النهارده — ${DAYS[d.todayWeekday]} ${date}</h2><p>تابع التنفيذ والسكريبتات والرفع من مكان واحد</p></div><button class="btn" data-act="today-add-toggle" type="button">＋ فيديو لليوم</button></div>
    <details class="today-summary" open><summary><span>ملخص اليوم والقنوات</span><span class="summary-count">${done} من ${entries.length} مهام مكتملة</span></summary>
      <div class="today-summary-body"><section class="today-metrics"><article class="metric-card metric-primary"><span>إنجاز مهام اليوم</span><strong>${done}<small> / ${entries.length}</small></strong><div class="metric-track"><i style="width:${entries.length ? Math.round(done / entries.length * 100) : 0}%"></i></div></article><article class="metric-card"><span>📤 الفيديوهات المرفوعة</span><strong>${uploaded}<small> / ${entries.filter((e) => e.is_video).length}</small></strong></article><article class="metric-card"><span>✍️ السكريبتات المكتوبة</span><strong>${scripts}<small> / ${entries.length}</small></strong></article><article class="metric-card"><span>المتبقي لهدف الأسبوع</span><strong>${d.progress.remaining}<small> فيديو</small></strong></article></section>
      <div class="today-channel-row"><span class="hint">القنوات:</span>${channels || '<span class="hint">مفيش مهام متعيّنة للقنوات النهارده</span>'}</div></div>
    </details>
    <section class="quick-add card" id="todayQuickAdd" hidden><select id="todayChannel">${d.channels.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><button class="btn" data-act="add-today" type="button">إضافة</button></section>
    ${dayGroup('مهام النهارده', `${entries.length} مهام · ${done} مكتملة`, entries, true, true, d.todayWeekday)}
    <div class="reset-row"><button class="btn ghost" data-act="open-reset" type="button">🔒 إعادة تعيين الجدول بالكامل</button></div>`;
}
function historyView() {
  const h = state.history || { weeks: [], month: { from: '', to: '', channels: [] }, resets: [] };
  const monthChannels = h.month?.channels || [];
  const planned = monthChannels.reduce((n, c) => n + c.planned, 0);
  const completed = monthChannels.reduce((n, c) => n + c.done, 0);
  const percent = planned ? Math.floor(completed / planned * 100) : 0;
  const bonus = h.weeks.reduce((n, w) => n + w.bonus, 0);
  const maxVideos = Math.max(1, ...h.weeks.map((w) => Math.max(w.videos, w.target)));
  const rows = h.weeks.map((w) => `<article class="history-row"><div><b>${fmtRange(w.week_start)}</b><small>${w.done}/${w.target} فيديو مكتمل</small></div><div class="history-bar"><i style="width:${w.percent}%"></i></div><strong>${w.percent}%</strong><span class="history-upload">📤 ${w.uploaded} مرفوع</span>${w.bonus ? `<span class="bonus">+${w.bonus} بونص</span>` : ''}</article>`).join('');
  const channelBars = monthChannels.map((c) => `<div class="channel-progress"><div><span><i style="--channel:${esc(c.color)}"></i>${esc(c.name)}</span><b>${c.done}/${c.planned} · ${c.percent}%</b></div><div class="history-bar"><i style="--bar:${esc(c.color)};width:${c.percent}%"></i></div></div>`).join('');
  const resets = h.resets.length ? h.resets.map((r) => `<div class="reset-log-row"><span>🔒</span><div><b>تصفير أسبوع ${fmtDay(r.week_start)}</b><small>${fmtDateTime(r.at)}</small></div><strong>${r.done}/${r.target}</strong></div>`).join('') : '<div class="empty">مفيش عمليات تصفير مسجلة</div>';
  const bars = h.weeks.slice(0, 8).reverse().map((w) => `<div class="trend-col" title="${fmtRange(w.week_start)} · ${w.done}/${w.target}"><i style="height:${Math.max(5, Math.round(w.done / maxVideos * 100))}%"></i><small>${fmtDay(w.week_start)}</small></div>`).join('');
  return `<div class="page-heading"><div><span class="eyebrow">متابعة الأداء</span><h2>السجل والتحليلات</h2><p>ملخص الالتزام والإنتاج عبر الأسابيع والقنوات</p></div><span class="period-chip">${h.month?.from ? `${fmtDay(h.month.from)} — ${fmtDay(addDaysStr(h.month.to, -1))}` : 'هذا الشهر'}</span></div>
    <section class="history-kpis"><article class="metric-card"><span>إجمالي الفيديوهات المكتملة هذا الشهر</span><strong>${completed}<small> / ${planned}</small></strong></article><article class="metric-card"><span>معدل الالتزام الشهري</span><strong>${percent}<small>%</small></strong><div class="metric-track"><i style="width:${percent}%"></i></div></article><article class="metric-card"><span>فيديوهات بونص</span><strong>${bonus}</strong></article></section>
    <div class="analytics-grid"><section class="panel"><div class="panel-head"><div><h3>التزام القنوات</h3><p>المكتمل مقارنة بالمخطط لهذا الشهر</p></div><span class="panel-icon">◉</span></div>${channelBars || '<div class="empty">لا توجد بيانات للقنوات في الفترة الحالية</div>'}</section><section class="panel"><div class="panel-head"><div><h3>اتجاه الإنتاج الأسبوعي</h3><p>آخر الأسابيع المسجلة</p></div><span class="panel-icon">⌁</span></div><div class="trend-chart">${bars || '<div class="empty">لا توجد أسابيع مسجلة بعد</div>'}</div></section></div>
    <section class="panel history-panel"><div class="panel-head"><div><h3>سجل الأسابيع</h3><p>الإنجاز والرفع والزيادة لكل أسبوع</p></div><span class="panel-icon">◷</span></div><div class="history-list">${rows || '<div class="empty">لا يوجد سجل إنتاج بعد</div>'}</div></section>
    <section class="panel history-panel"><div class="panel-head"><div><h3>سجل التصفير</h3><p>نتائج الأسابيع قبل إعادة تعيينها</p></div><span class="panel-icon">⟲</span></div><div class="reset-log">${resets}</div></section>`;
}

function taskCard(e) {
  const open = state.open.has(e.id);
  const ch = e.channel;
  const upTitle = e.uploaded_at ? `اترفع ${fmtDateTime(e.uploaded_at)}` : 'علّم لما ترفع الفيديو على المنصة';
  return `<article class="task ${e.done ? 'done' : ''} ${open ? 'open' : ''}">
    <div class="t-head">
      <label class="chk"><input type="checkbox" data-act="done" data-id="${e.id}" ${e.done ? 'checked' : ''}><span>اكتمل</span></label>
      <label class="chk up" title="${esc(upTitle)}"><input type="checkbox" data-act="uploaded" data-id="${e.id}" ${e.uploaded_at ? 'checked' : ''}><span>تم الرفع</span></label>
      ${scriptFlag(e)}
      ${noteFlag(e)}
      ${ch ? `<span class="badge" style="--c:${esc(ch.color)}">${chLabel(ch)}</span>` : ''}

      ${e.is_video ? '' : '<span class="flag">مهمة عادية</span>'}
      <button class="chev" data-act="toggle" data-id="${e.id}" aria-expanded="${open}" aria-label="تفاصيل" type="button">${open ? '▴' : '▾'}</button>
    </div>
    ${open ? taskBody(e) : ''}
  </article>`;
}

function taskBody(e) {
  const d = state.data;
  const providers = d.integrations.aiProviders;
  const busyT = state.busy.has(`t${e.id}`);
  const chosenProvider = state.provider || d.settings.aiProvider;
  return `<div class="t-body">
    <section class="production-section script-editor-section"><div class="section-heading"><div><h4>✍️ نص السكريبت</h4><p>اكتب النص وراجعه هنا — الحفظ تلقائي</p></div><span class="section-mark">كتابة</span>${proofreadButton(e)}</div>
      <textarea class="auto script-editor" data-id="${e.id}" data-field="script" placeholder="ابدأ كتابة السكريبت هنا… المساحة تتمدد تلقائيًا مع النص">${esc(e.script)}</textarea>
    </section>

    <div class="production-grid">
    <section class="box production-panel notes-panel"><h4>📝 ملاحظات وروابط</h4>
      <textarea class="auto" data-id="${e.id}" data-field="notes" placeholder="ملاحظات، مراجع، أو روابط مرتبطة بالفيديو">${esc(e.notes)}</textarea>
      <ul class="links">${linksHtml(e.notes)}</ul>
    </section>

    <section class="box production-panel titles-panel"><h4>✨ اقتراحات العناوين</h4>
      <div class="row">
        <select data-prov style="width:auto">
          <option value="auto" ${chosenProvider === 'auto' ? 'selected' : ''}>تلقائي</option>
          ${['anthropic', 'gemini', 'openai', 'openrouter']
            .filter((p) => providers.includes(p))
            .map((p) => `<option value="${p}" ${chosenProvider === p ? 'selected' : ''}>${{ anthropic: 'Claude', gemini: 'Gemini', openai: 'OpenAI', openrouter: 'OpenRouter' }[p]}</option>`)
            .join('')}
        </select>
        <button class="btn small" data-act="titles" data-id="${e.id}" type="button" ${busyT ? 'disabled' : ''}>${busyT ? '⏳ بيكتب…' : e.titles.length ? '🔄 ولّد تاني' : '✨ ولّد العناوين'}</button>
      </div>
      ${providers.length ? '' : '<p class="hint">محتاج مفتاح ذكاء اصطناعي في ملف .env (ANTHROPIC_API_KEY أو GEMINI_API_KEY أو OPENAI_API_KEY أو OPENROUTER_API_KEY).</p>'}
      <div class="titles">${e.titles
        .map(
          (t, i) => `<div class="row"><button class="title-opt grow ${t === e.chosen_title ? 'picked' : ''}" data-act="pick-title" data-id="${e.id}" data-i="${i}" type="button">${t === e.chosen_title ? '✅ ' : ''}${esc(t)}</button>
            <button class="btn small ghost" data-act="copy-title" data-id="${e.id}" data-i="${i}" type="button">📋</button></div>`,
        )
        .join('')}</div>
    </section>

    <section class="box production-panel thumbnail-panel"><div class="panel-title"><h4>🖼️ الصورة المصغرة</h4><span class="section-mark">Google Flow</span></div>
      <p class="hint">البرومبت جاهز حسب عنوان الفيديو وإعدادات القناة.</p>
      <button class="btn flow-button" data-act="flow" data-id="${e.id}" type="button">📋 انسخ البرومبت وافتح Google Flow</button>
      ${e.thumb_url ? `<div class="thumb"><img src="${esc(e.thumb_url)}" alt="الصورة المصغرة" loading="lazy"><div class="row"><a class="btn small ghost" href="${esc(e.thumb_url)}" download>⬇️ تحميل الصورة</a></div></div>` : ''}
    </section>
    </div>
  </div>`;
}

// ───────────── نافذة تصفير الجدول (منقولة من الموقع القديم) ─────────────
function openResetModal() {
  state.modal = { reset: true };
  $('#modalRoot').innerHTML = `<div class="modal-back center"><div class="modal reset-box" role="dialog" aria-modal="true" aria-label="تصفير الجدول">
    <div class="r-icon">🔒</div>
    <h2>متأكد إنك عايز تصفّر الجدول؟</h2>
    <p class="hint">هيتمسح كل علامات "تم" والسكريبتات والعناوين بتاعت الأسبوع الحالي، والنتيجة بتتسجل. اكتب الباسورد عشان تأكد.</p>
    <label class="lbl" for="resetPw">كلمة مرور التصفير</label><input type="password" id="resetPw" placeholder="الباسورد" autocomplete="off" dir="ltr">
    <p class="r-error" id="resetErr" hidden></p>
    <div class="foot"><button class="btn ghost" data-act="r-cancel" type="button">إلغاء</button><button class="btn danger" data-act="r-confirm" type="button">تأكيد المسح</button></div>
  </div></div>`;
  $('#resetPw').focus();
}

async function confirmReset() {
  const input = $('#resetPw');
  if (!input) return;
  try {
    await api('/reset', { method: 'POST', body: { password: input.value } });
    closeModal();
    state.open.clear();
    await load();
    toast('🔒 اتصفّر الأسبوع الحالي');
  } catch (e) {
    const err = $('#resetErr');
    err.textContent = e.message;
    err.hidden = false;
    input.classList.remove('shake');
    void input.offsetWidth;
    input.classList.add('shake');
    input.value = '';
    input.focus();
  }
}

// ───────────── صفحة السكريبتات ─────────────
function weekOrder() {
  const start = state.data.settings.weekStartDay;
  return Array.from({ length: 7 }, (_, i) => (start + i) % 7);
}

function taskOptions() {
  const d = state.data;
  const opt = (e) => `<option value="${e.id}">${esc(e.channel?.name || 'بدون قناة')}${e.script.trim() ? ' ✍️ (فيه سكريبت)' : ''}</option>`;
  const groups = weekOrder()
    .map((wd) => [DAYS[wd], d.entries.filter((e) => e.day === wd)])
    .concat([['من غير يوم', d.entries.filter((e) => e.day === null)]])
    .filter(([, list]) => list.length);
  return `<option value="">— اختار القناة —</option>${groups.map(([name, list]) => `<optgroup label="${esc(name)}">${list.map(opt).join('')}</optgroup>`).join('')}`;
}

function scriptCard(e) {
  const ch = e.channel;
  return `<article class="task s-card ${hasScript(e) ? 'ready' : ''}" data-sid="${e.id}">
    <div class="t-head">
      ${scriptFlag(e)}
      ${ch ? `<span class="badge" style="--c:${esc(ch.color)}">${chLabel(ch)}</span>` : ''}

      <select data-id="${e.id}" data-field="day" title="انقل المهمة ليوم تاني"><option value="">أي يوم</option>
        ${DAYS.map((n, i) => `<option value="${i}" ${e.day === i ? 'selected' : ''}>${n}</option>`).join('')}</select>
    </div>
    <div class="t-body"><label class="script-editor-label" for="script-${e.id}">✍️ مساحة كتابة السكريبت <small>الحفظ تلقائي</small></label><textarea id="script-${e.id}" class="auto script-editor" data-id="${e.id}" data-field="script" placeholder="اكتب سكريبت قناة «${esc(ch?.name || 'القناة')}» هنا… المساحة تتمدد تلقائيًا">${esc(e.script)}</textarea><div class="script-card-foot"><span>${hasScript(e) ? '✅ السكريبت محفوظ' : 'ابدأ الكتابة — سيظهر اكتمال السكريبت تلقائيًا'}</span><span>${esc(ch?.name || 'بدون قناة')}</span>${proofreadButton(e)}</div></div>
  </article>`;
}

function bankItem(b) {
  return `<div class="box bank-item">
    <input type="text" data-bid="${b.id}" data-bf="title" value="${esc(b.title)}" placeholder="عنوان / الهوك" maxlength="300">
    <textarea class="auto" data-bid="${b.id}" data-bf="body">${esc(b.body)}</textarea>
    <div class="row">
      <select id="assign-${b.id}" class="grow">${taskOptions()}</select>
      <button class="btn small" data-act="assign-bank" data-bid="${b.id}" type="button">📤 وزّع على المهمة</button>
      <button class="btn small danger" data-act="delete-bank" data-bid="${b.id}" type="button">🗑️</button>
    </div>
  </div>`;
}

function scriptsView() {
  const d = state.data;
  const sel = state.sDay ?? d.todayWeekday;
  const chip = (key, label, list, isToday) => {
    const ready = list.filter(hasScript).length;
    const all = list.length > 0 && ready === list.length;
    return `<button class="schip${String(sel) === String(key) ? ' active' : ''}${all ? ' ok' : ''}${isToday ? ' today' : ''}" data-act="s-day" data-d="${key}" type="button">${label}<small>${ready}/${list.length}</small></button>`;
  };
  const chips = weekOrder()
    .filter((wd) => d.entries.some((e) => e.day === wd) || d.settings.workDays.includes(wd))
    .map((wd) => chip(wd, DAYS[wd], d.entries.filter((e) => e.day === wd), wd === d.todayWeekday));
  const loose = d.entries.filter((e) => e.day === null);
  if (loose.length) chips.push(chip('none', 'من غير يوم', loose, false));
  const list = sel === 'none' ? loose : d.entries.filter((e) => e.day === Number(sel));
  return `<p class="hint">✍️ اكتب سكريبتات الأيام هنا، ولما تكتب أي حاجة بيظهر "✅ تم كتابة السكريبت" لوحده وبيبان في جدول الأسبوع. وتقدر تنقل أي مهمة ليوم تاني من القائمة اللي جنبها.</p>
    <div class="schips">${chips.join('')}</div>
    ${list.length ? list.map(scriptCard).join('') : '<div class="empty">مفيش مهام في اليوم ده</div>'}
    <section class="bank">
      <h3 class="group-title">📥 مخزن السكريبتات <small>اكتب سكريبتات الأول وبعدين وزّعها على المهام</small></h3>
      <div class="box bank-item">
        <input type="text" id="bankTitle" placeholder="عنوان / الهوك (اختياري)" maxlength="300">
        <textarea class="auto" id="bankBody" placeholder="اكتب أو الصق سكريبت هنا…"></textarea>
        <div class="row"><button class="btn" data-act="add-bank" type="button">➕ احفظ في المخزن</button></div>
      </div>
      ${state.bank.length ? state.bank.map(bankItem).join('') : '<div class="empty" style="margin-top:8px">المخزن فاضي</div>'}
    </section>`;
}

// ───────────── الأحداث ─────────────
async function guarded(fn) {
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
  }
}

async function mutate(id, patch) {
  const updated = await api(`/entries/${id}`, { method: 'PATCH', body: patch });
  replaceEntry(updated);
  await load();
}

document.addEventListener('click', (ev) => {
  const card = ev.target.closest('.task');
  if (!card || ev.target.closest('button, a, input, textarea, select, label, [contenteditable="true"], [data-act]')) return;
  card.querySelector('[data-act="toggle"]')?.click();
});

document.addEventListener('click', (ev) => {
  if (ev.target.classList?.contains('modal-back')) return closeModal();
  const el = ev.target.closest('[data-act]');
  if (!el || ['done', 'uploaded'].includes(el.dataset.act)) return;
  const id = Number(el.dataset.id);
  const bid = Number(el.dataset.bid);
  const act = el.dataset.act;
  guarded(async () => {
    switch (act) {
      case 'week-prev':
      case 'header-week-prev':
        state.viewWeek = state.data.prevWeek;
        if (pageIs() === 'today') location.hash = '#/week';
        return load();
      case 'week-next':
      case 'header-week-next':
        state.viewWeek = state.data.nextWeek;
        if (pageIs() === 'today') location.hash = '#/week';
        return load();
      case 'today-add-toggle': {
        const form = $('#todayQuickAdd');
        form.hidden = !form.hidden;
        if (!form.hidden) $('#todayChannel').focus();
        return;
      }
      case 'add-today': {
        const channelId = Number($('#todayChannel').value) || null;
        const title = state.data.channels.find((channel) => channel.id === channelId)?.name || '';
        if (!title) return toast('اختار قناة الفيديو', true);
        const created = await api('/entries', { method: 'POST', body: { title, channel_id: channelId, day: state.data.todayWeekday } });
        state.open.add(created.id);
        return load();
      }
      case 'strip':
        document.querySelector(`.day[data-wd="${el.dataset.wd}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      case 'open-reset':
        return openResetModal();
      case 'r-cancel':
        return closeModal();
      case 'r-confirm':
        return confirmReset();
      case 's-day':
        state.sDay = el.dataset.d === 'none' ? 'none' : Number(el.dataset.d);
        return render();
      case 'add-bank': {
        const title = $('#bankTitle').value;
        const body = $('#bankBody').value;
        if (!title.trim() && !body.trim()) return toast('اكتب عنوان أو سكريبت الأول', true);
        state.bank.unshift(await api('/bank', { method: 'POST', body: { title, body } }));
        $('#bankTitle').value = '';
        $('#bankBody').value = '';
        render();
        return toast('📥 اتحفظ في المخزن');
      }
      case 'delete-bank':
        if (!confirm('تمسح السكريبت ده من المخزن؟')) return;
        await flushAll();
        await api(`/bank/${bid}`, { method: 'DELETE' });
        state.bank = state.bank.filter((b) => b.id !== bid);
        return render();
      case 'assign-bank': {
        const entryId = Number($(`#assign-${bid}`).value);
        if (!entryId) return toast('اختار المهمة اللي هتوزّع عليها الأول', true);
        await flushAll();
        const overwrite = !!entryById(entryId)?.script.trim();
        if (overwrite && !confirm('المهمة دي فيها سكريبت. تستبدله بالسكريبت ده؟')) return;
        await api(`/bank/${bid}/assign`, { method: 'POST', body: { entry_id: entryId, overwrite } });
        toast('📤 اتوزّع على المهمة');
        return load();
      }
      case 'toggle':
        state.open.has(id) ? state.open.delete(id) : state.open.add(id);
        render();
        break;
      case 'dismiss-demo':
        try {
          localStorage.setItem('demoDismissed', '1');
        } catch {
          /* تجاهل */
        }
        render();
        break;
      case 'delete':
        if (!confirm('متأكد إنك عايز تحذف المهمة دي؟ السكريبت بتاعها هيتمسح.')) return;
        await api(`/entries/${id}`, { method: 'DELETE' });
        state.open.delete(id);
        return load();
      case 'add-extra': {
        const channelId = Number($('#extraChannel').value) || null;
        const channel = state.data.channels.find((c) => c.id === channelId);
        const title = channel?.name || '';
        if (!title) return toast('اختار قناة الفيديو', true);
        const created = await api('/entries', {
          method: 'POST',
          body: { title, channel_id: channelId, week: state.data.weekStart },
        });
        state.open.add(created.id);
        return load();
      }
      case 'titles':
        return genTitles(id);
      case 'proofread':
        return proofread(id);
      case 'proofread':
        return proofread(id);
      case 'pick-title': {
        const e = entryById(id);
        const t = e.titles[Number(el.dataset.i)];
        return mutate(id, { chosen_title: t === e.chosen_title ? '' : t });
      }
      case 'copy-title':
        await copyText(entryById(id).titles[Number(el.dataset.i)]);
        return toast('📋 العنوان اتنسخ');
      case 'flow': {
        const flowTab = window.open(state.data.integrations.flowUrl, '_blank');
        if (flowTab) flowTab.opener = null;
        await flushAll();
        await copyText(promptValue(id));
        return toast(flowTab ? '✅ الوصف اتنسخ وFlow اتفتح — الصقه واضغط إنشاء' : '📋 الوصف اتنسخ — اسمح بالنوافذ المنبثقة لفتح Flow');
      }
      case 'notify':
        return onNotifyClick();
      case 'settings':
        return openSettings();
      default:
        if (act.startsWith('m-')) return modalAction(act, el);
    }
  });
});

document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset?.act === 'done') {
    const id = Number(el.dataset.id);
    const todayTasks = state.data.entries.filter((entry) => entry.day === state.data.todayWeekday);
    const completedDay = el.checked && todayTasks.length > 0 && todayTasks.every((entry) => entry.done || entry.id === id);
    return guarded(async () => {
      await mutate(id, { done: el.checked });
      if (completedDay && pageIs() === 'today') celebrateToday();
    });
  }
  if (el.dataset?.act === 'uploaded') {
    const id = Number(el.dataset.id);
    return guarded(async () => {
      replaceEntry(await api(`/entries/${id}/upload`, { method: el.checked ? 'POST' : 'DELETE', body: el.checked ? { platforms: [] } : undefined }));
      await load();
    });
  }
  if (el.matches?.('[data-prov]')) {
    state.provider = el.value;
    return;
  }
  const field = el.dataset?.field;
  if (!field || !el.dataset.id) return;
  const id = Number(el.dataset.id);
  if (field === 'channel_id') return guarded(() => mutate(id, { channel_id: el.value === '' ? null : Number(el.value) }));
  if (field === 'day') return guarded(() => mutate(id, { day: el.value === '' ? null : Number(el.value) }));
  if (field === 'is_video') return guarded(() => mutate(id, { is_video: el.checked }));
});

function celebrateToday() {
  document.querySelector('.day-celebration')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'day-celebration';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  overlay.innerHTML = `<div class="celebration-confetti" aria-hidden="true">${Array.from({ length: 18 }, (_, i) => `<span style="--x:${8 + i * 4.7}%;--hue:${i * 25};--duration:${1.6 + (i % 5) * 0.28}s;--delay:${i * 0.035}s">${['✦', '✧', '●', '✦', '✺'][i % 5]}</span>`).join('')}</div><div class="celebration-card"><span class="celebration-icon">🎉</span><p class="eyebrow">إنجاز اليوم اكتمل</p><h2>عاش! خلّصت مهام النهارده</h2><p>كل خطوة خلصتها قرّبتك من هدفك الأسبوعي.</p><button class="btn" type="button" data-celebrate-close>كمّل بنفس الحماس</button></div>`;
  document.body.append(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay || ev.target.closest('[data-celebrate-close]')) close(); });
  window.setTimeout(close, 4200);
}

// تحديث علامة "تم كتابة السكريبت" والعدّادات وقت الكتابة من غير إعادة رسم
function refreshScriptUi(e) {
  const on = hasScript(e);
  document.querySelectorAll(`[data-sflag="${e.id}"]`).forEach((f) => (f.hidden = !on));
  document.querySelectorAll(`[data-nflag="${e.id}"]`).forEach((f) => (f.hidden = on || !hasNotes(e)));
  document.querySelector(`.s-card[data-sid="${e.id}"]`)?.classList.toggle('ready', on);
  document.querySelectorAll('.schip').forEach((c) => {
    const k = c.dataset.d;
    const list = state.data.entries.filter((x) => (k === 'none' ? x.day === null : x.day === Number(k)));
    const n = list.filter(hasScript).length;
    c.querySelector('small').textContent = `${n}/${list.length}`;
    c.classList.toggle('ok', list.length > 0 && n === list.length);
  });
}

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.matches?.('textarea.auto')) autosize(el);
  if (el.dataset?.bid) {
    const b = state.bank.find((x) => x.id === Number(el.dataset.bid));
    if (b) {
      b[el.dataset.bf] = el.value;
      scheduleSave(b.id, el.dataset.bf, el.value, 'bank');
    }
    return;
  }
  const field = el.dataset?.field;
  if (!field || !el.dataset.id || !['script', 'notes', 'title', 'thumb_prompt'].includes(field)) return;
  const id = Number(el.dataset.id);
  const e = entryById(id);
  if (!e) return;
  if (field === 'title' && !el.value.trim()) return; // العنوان مينفعش يتفرّغ
  e[field] = el.value;
  if (field === 'script') refreshScriptUi(e);
  if (field === 'notes') {
    document.querySelectorAll(`[data-nflag="${e.id}"]`).forEach((f) => (f.hidden = hasScript(e) || !hasNotes(e)));
    const ul = el.parentElement.querySelector('.links');
    if (ul) ul.innerHTML = linksHtml(el.value);
  }
  scheduleSave(id, field, el.value);
});

document.addEventListener('focusout', (ev) => {
  const el = ev.target;
  if (el.dataset?.field && el.dataset.id) flushOne(`entries:${el.dataset.id}:${el.dataset.field}`);
  if (el.dataset?.bid) flushOne(`bank:${el.dataset.bid}:${el.dataset.bf}`);
});
window.addEventListener('pagehide', () => flushAll(true));
window.addEventListener('resize', () => autosizeAll());
window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  if (state.modal?.settingsPage && location.hash !== '#/settings') {
    state.modal = null;
    $('#modalRoot').innerHTML = '';
    document.body.classList.remove('settings-open');
  }
  if (state.modal?.settingsPage && location.hash === '#/settings') return;
  if (pageIs() === 'today' && state.viewWeek) {
    state.viewWeek = null;
    guarded(load);
  } else render();
});
window.addEventListener('online', () => setOnline(true));
window.addEventListener('offline', () => setOnline(false));
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeModal();
  if (ev.key === 'Enter' && ev.target.id === 'resetPw') confirmReset();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !state.modal && !state.busy.size) guarded(() => load());
});

// ───────────── الذكاء الاصطناعي ─────────────
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    window.prompt('انسخ النص من هنا:', text);
  }
}
const promptValue = (id) => {
  const e = entryById(id);
  return e?.thumb_prompt?.trim() || e?.suggested_thumb_prompt || '';
};

async function genTitles(id) {
  state.busy.add(`t${id}`);
  render();
  try {
    await flushAll();
    const r = await api(`/entries/${id}/titles`, { method: 'POST', body: { provider: state.provider || undefined } });
    replaceEntry(r.entry);
    toast('✨ العناوين جاهزة — اختار واحد');
  } finally {
    state.busy.delete(`t${id}`);
    render();
  }
}

async function proofread(id) {
  const e = entryById(id);
  if (!hasScript(e)) return toast('اكتب السكريبت الأول قبل التدقيق', true);
  if (!state.data.integrations.aiProviders.includes('gemini')) return toast('التدقيق محتاج مفتاح Gemini على السيرفر', true);
  state.busy.add('p' + id);
  render();
  try {
    await flushAll();
    const r = await api('/entries/' + id + '/proofread', { method: 'POST' });
    replaceEntry(r.entry);
    toast('✅ اتصححت الأخطاء الإملائية مع الحفاظ على صياغتك');
  } finally {
    state.busy.delete('p' + id);
    render();
  }
}

// ───────────── الإشعارات ─────────────
const b64ToU8 = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const pushSupported = () => 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

async function updateNotifyBtn() {
  const btn = $('#btnNotify');
  if (!pushSupported()) {
    btn.textContent = '🔕';
    btn.title = 'الإشعارات مش مدعومة في المتصفح ده';
    btn.setAttribute('aria-label', btn.title);
    return;
  }
  const sub = await currentSubscription();
  btn.textContent = '🔔';
  btn.title = sub && Notification.permission === 'granted' ? 'الإشعارات مفعّلة — اضغط لإرسال إشعار تجريبي' : 'فعّل الإشعارات';
  btn.setAttribute('aria-label', btn.title);
}

async function enableNotifications() {
  if (!pushSupported()) throw new Error('المتصفح ده مش بيدعم الإشعارات. جرّب Chrome أو Edge.');
  if (!window.isSecureContext) throw new Error('الإشعارات بتشتغل بس على localhost أو HTTPS.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('لازم تسمح بالإشعارات من إعدادات المتصفح.');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToU8(state.data.integrations.pushPublicKey),
    });
  }
  await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  await updateNotifyBtn();
  toast('🔔 الإشعارات اتفعّلت على الجهاز ده');
}

async function onNotifyClick() {
  const sub = await currentSubscription();
  if (sub && Notification.permission === 'granted') {
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    await api('/push/test', { method: 'POST' });
    return toast('🔔 بعتّلك إشعار تجريبي');
  }
  await enableNotifications();
}

// ───────────── الإعدادات (مودال) ─────────────
async function openSettings() {
  const d = state.data;
  if (!d) return toast('استنى تحميل بيانات الصفحة الأول', true);
  state.returnHash = location.hash && location.hash !== '#/settings' ? location.hash : '#/today';
  state.modal = { settingsPage: true };
  document.body.classList.add('settings-open');
  location.hash = '#/settings';
  state.modal = {
    settings: JSON.parse(JSON.stringify(d.settings)),
    channels: d.channels.map((c) => ({ ...c })),
    tasks: (d.template || []).map((t) => ({ ...t })),
    deletedChannels: [],
    tmp: -1,
    settingsPage: true,
  };
  renderModal();
}
function closeModal() {
  if (!state.modal) return;
  const restore = state.modal.settingsPage ? state.returnHash : '';
  state.modal = null;
  $('#modalRoot').innerHTML = '';
  document.body.classList.remove('settings-open');
  if (restore && location.hash !== restore) location.hash = restore;
  else if (restore) render();
}

function renderModal() {
  const m = state.modal;
  const s = m.settings;
  const d = state.data;
  const dayOpts = (sel) =>
    `<option value="">أي يوم</option>${DAYS.map((n, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${n}</option>`).join('')}`;
  const chOpts = (sel) =>
    `<option value="">— من غير قناة —</option>${m.channels
      .map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name || 'قناة جديدة')}</option>`)
      .join('')}`;
  const taskRow = ({ task: t, index: i, order }) => `<article class="template-task-row" data-tk="${i}">
    <span class="template-task-order">${String(order).padStart(2, '0')}</span>
    <div class="template-task-fields">
      <input type="hidden" data-k="title" value="${esc(t.title)}"><span class="template-task-channel">${esc(m.channels.find((c) => c.id === t.channel_id)?.name || 'من غير قناة')}</span>
      <div class="template-task-controls">
        <select data-k="channel" aria-label="القناة">${chOpts(t.channel_id)}</select>
        <select data-k="day" aria-label="نقل إلى يوم">${dayOpts(t.day)}</select>
        <label class="template-video-toggle"><input type="checkbox" data-k="video" ${t.is_video ? 'checked' : ''}> فيديو</label>
        <button class="btn small danger" data-act="m-del-task" data-i="${i}" type="button" aria-label="حذف المهمة">حذف</button>
      </div>
    </div>
  </article>`;
  const taskGroup = (day, label) => {
    const items = m.tasks.map((task, index) => ({ task, index })).filter(({ task }) => task.day === day);
    const videoCount = items.filter(({ task }) => task.is_video).length;
    return `<section class="template-day-group" data-template-day="${day ?? 'none'}">
      <header class="template-day-head"><div class="template-day-name"><span class="template-day-dot"></span><h4>${label}</h4><small>${items.length} مهمة · ${videoCount} فيديو</small></div>
        <button class="btn small ghost" data-act="m-add-task" data-day="${day ?? 'none'}" type="button">＋ إضافة مهمة</button></header>
      <div class="template-task-list">${items.length ? items.map((item, index) => taskRow({ ...item, order: index + 1 })).join('') : '<p class="template-day-empty">لا توجد مهام في هذا اليوم</p>'}</div>
    </section>`;
  };
  $('#modalRoot').innerHTML = `<div class="modal-back settings-page"><div class="modal settings-sheet" role="dialog" aria-modal="true" aria-label="الإعدادات">
    <div class="settings-intro"><span class="eyebrow">تخصيص مساحة العمل</span><h2>إعدادات منصة الإنتاج والقنوات</h2><p class="hint">ضبط أهداف الأسبوع، أسلوب القنوات، وأدوات إنتاج المحتوى.</p></div>
    <div class="settings-kpis"><article><span>الهدف الأسبوعي</span><strong>${s.weeklyTarget} فيديو</strong></article><article><span>أيام العمل</span><strong>${s.workDays.length} أيام</strong></article><article><span>القنوات النشطة</span><strong>${m.channels.length} قنوات</strong></article><article><span>محرّك الذكاء الاصطناعي</span><strong>${{ auto: 'تلقائي', anthropic: 'Claude', gemini: 'Gemini', openai: 'OpenAI', openrouter: 'OpenRouter' }[s.aiProvider] || 'تلقائي'}</strong></article></div>

    <section><h3>🎯 هدف الأسبوع والجدول الزمني</h3>
      <div class="row">
        <div><label class="lbl">عدد الفيديوهات = أسبوع كامل</label><input type="number" id="s_target" min="1" max="200" value="${s.weeklyTarget}" style="width:110px"></div>
        <div><label class="lbl">الأسبوع بيبدأ يوم</label><select id="s_start" style="width:auto">${DAYS.map((n, i) => `<option value="${i}" ${s.weekStartDay === i ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      </div>
      <label class="lbl" style="margin-top:10px">أيام الشغل (التذكير بيتبعت فيها بس)</label>
      <div class="days">${DAYS.map((n, i) => `<label class="pill ${s.workDays.includes(i) ? 'on' : ''}"><input type="checkbox" data-wd="${i}" ${s.workDays.includes(i) ? 'checked' : ''} hidden>${n}</label>`).join('')}</div>
      <p class="hint">أي فيديو بتخلصه فوق الهدف بيتحسب بونص، والنسبة بتثبت على 100%.</p>
    </section>

    <section><h3>🔔 التذكير اليومي</h3>
      <div class="row">
        <label><input type="checkbox" id="s_remind" ${s.reminderEnabled ? 'checked' : ''}> فعّل التذكير اليومي</label>
        <div><input type="time" id="s_time" value="${esc(s.reminderTime)}" style="width:130px"></div>
        <div class="grow"><input type="text" id="s_tz" value="${esc(s.timezone)}" placeholder="Africa/Cairo" dir="ltr"></div>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="btn small" data-act="m-enable-notify" type="button">🔔 فعّل الإشعارات على الجهاز ده</button>
        <button class="btn small ghost" data-act="m-test-reminder" type="button">▶️ جرّب التذكير دلوقتي</button>
        <span class="hint">أجهزة مشتركة: ${d.integrations.pushSubscribers}</span>
      </div>
      <p class="hint">الإشعار بيوصل طول ما السيرفر شغال (على جهازك أو على استضافة شغالة 24 ساعة).</p>
    </section>

    <section><h3>إدارة القنوات وأسلوب المحتوى</h3>
      <div class="settings-channel-grid">${m.channels
        .map(
          (c, i) => `<article class="channel-edit-card" data-ch="${i}">
            <div class="channel-edit-head"><input type="text" data-k="icon" class="icon-in" value="${esc(c.icon || '')}" placeholder="😀" maxlength="8" title="أيقونة القناة (إيموجي)"><input type="text" data-k="name" value="${esc(c.name)}" placeholder="اسم القناة" maxlength="60"><input type="color" data-k="color" value="${esc(c.color)}"><button class="btn small danger" data-act="m-del-ch" data-i="${i}" type="button">حذف</button></div>
            <label class="lbl">أسلوب وهوية القناة<textarea class="auto short" data-k="style" placeholder="وصف نبرة القناة وهويتها البصرية، ويُستخدم في العناوين والصور">${esc(c.style)}</textarea></label>
            <details class="channel-prompts"><summary>برومبتات الذكاء الاصطناعي <small>اختياري</small></summary><div class="channel-prompt-grid"><label class="lbl">📝 برومبت عناوين الفيديو<textarea class="auto short" data-k="title_prompt" placeholder="اتركه فارغًا لاستخدام الافتراضي. بيانات الفيديو وعدد العناوين تُضاف تلقائيًا.">${esc(c.title_prompt || '')}</textarea></label><label class="lbl">🖼️ برومبت الصور المصغرة<textarea class="auto short" data-k="image_prompt" placeholder="اتركه فارغًا لاستخدام الافتراضي. بيانات الفيديو وأسلوب القناة يُضافان تلقائيًا.">${esc(c.image_prompt || '')}</textarea></label></div></details>
          </article>`,
        )
        .join('')}</div>
      <button class="btn small ghost" data-act="m-add-ch" type="button">➕ قناة جديدة</button>
    </section>

    <section class="template-manager"><div class="template-section-intro"><div><h3>📋 قائمة المهام الأسبوعية الثابتة</h3><p class="hint">رتّب مهامك حسب اليوم. استخدم قائمة النقل لتغيير يوم أي مهمة.</p></div><span class="template-total">${m.tasks.length} مهمة</span></div>
      <div class="template-day-groups">${DAYS.map((label, day) => taskGroup(day, label)).join('')}${taskGroup(null, 'من غير يوم')}</div>
      <p class="hint">التعديل بيتطبق على الأسبوع الحالي والأسابيع الجاية. المهام اللي خلصت أو فيها سكريبت متتمسحش.</p>
    </section>

    <section><h3>🤖 الذكاء الاصطناعي والمنصات</h3>
      <div class="row">
        <div><label class="lbl">مزوّد العناوين</label><select id="s_ai" style="width:auto">
          ${['auto', 'anthropic', 'gemini', 'openai', 'openrouter'].map((p) => { const available = p === 'auto' || state.data.integrations.aiProviders.includes(p); const names = { auto: 'تلقائي', anthropic: 'Claude', gemini: 'Gemini', openai: 'OpenAI', openrouter: 'OpenRouter' }; return `<option value="${p}" ${s.aiProvider === p ? 'selected' : ''} ${available ? '' : 'disabled'}>${names[p]}${available ? '' : ' (المفتاح غير مضاف)'}</option>`; }).join('')}</select></div>
        <div><label class="lbl">أبعاد الصورة المصغرة</label><select id="s_aspect" style="width:auto">
          ${['16:9', '9:16', '1:1', '4:3'].map((a) => `<option ${s.thumbAspect === a ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
        <div class="grow"><label class="lbl">المنصات (مفصولة بفاصلة)</label><input type="text" id="s_platforms" value="${esc(s.platforms.join('، '))}"></div>
      </div>
      <p class="hint">مفاتيح الـ API بتتحط في ملف .env على السيرفر — مش من هنا.</p>
    </section>

    <section class="danger-zone"><h3>🔒 تصفير الأسبوع الحالي</h3>
      <p class="hint">بيمسح علامات "تم" والسكريبتات والعناوين بتاعت الأسبوع الحالي ويبدأه من الأول. النتيجة بتتسجل في السجل.</p>
      <label class="lbl" for="s_resetpw">كلمة مرور التصفير</label><div class="row"><input type="password" id="s_resetpw" placeholder="كلمة السر" class="grow" autocomplete="off">
        <button class="btn small danger" data-act="m-reset" type="button">تصفير</button></div>
    </section>

    <div class="foot"><button class="btn ghost" data-act="m-close" type="button">إلغاء</button><button class="btn" data-act="m-save" type="button">💾 حفظ</button></div>
  </div></div>`;
  autosizeAll($('#modalRoot'));

}

function readModal() {
  const m = state.modal;
  const root = $('#modalRoot');
  const s = m.settings;
  s.weeklyTarget = Number($('#s_target', root).value);
  s.weekStartDay = Number($('#s_start', root).value);
  s.workDays = $$('[data-wd]', root).filter((x) => x.checked).map((x) => Number(x.dataset.wd));
  s.reminderEnabled = $('#s_remind', root).checked;
  s.reminderTime = $('#s_time', root).value;
  s.timezone = $('#s_tz', root).value.trim();
  s.aiProvider = $('#s_ai', root).value;
  s.thumbAspect = $('#s_aspect', root).value;
  s.platforms = $('#s_platforms', root).value.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean);
  m.channels.forEach((c, i) => {
    const row = $(`[data-ch="${i}"]`, root);
    c.icon = $('[data-k=icon]', row).value.trim();
    c.name = $('[data-k=name]', row).value;
    c.color = $('[data-k=color]', row).value;
    c.style = $('[data-k=style]', row).value;
    c.title_prompt = $('[data-k=title_prompt]', row).value;
    c.image_prompt = $('[data-k=image_prompt]', row).value;
  });
  m.tasks.forEach((t, i) => {
    const row = $(`[data-tk="${i}"]`, root);
    t.channel_id = $('[data-k=channel]', row).value === '' ? null : Number($('[data-k=channel]', row).value);
    t.title = m.channels.find((c) => c.id === t.channel_id)?.name || '';
    t.day = $('[data-k=day]', row).value === '' ? null : Number($('[data-k=day]', row).value);
    t.is_video = $('[data-k=video]', row).checked;
  });
}

document.addEventListener('change', (ev) => {
  // تلوين أزرار أيام الشغل لحظيًا
  const wd = ev.target.dataset?.wd;
  if (wd !== undefined) ev.target.closest('.pill').classList.toggle('on', ev.target.checked);
  if (ev.target.matches?.('#modalRoot [data-k="day"]')) {
    const index = ev.target.closest('[data-tk]')?.dataset.tk;
    if (index === undefined) return;
    readModal();
    renderModal();
    return $(`[data-tk="${index}"] [data-k="day"]`, $('#modalRoot'))?.focus();
  }
});

async function modalAction(act, el) {
  const m = state.modal;
  if (!m) return;
  if (act === 'm-close') return closeModal();
  if (act === 'm-enable-notify') return enableNotifications();
  if (act === 'm-test-reminder') {
    const r = await api('/reminders/run', { method: 'POST' });
    const msg = {
      sent: `🔔 اتبعت التذكير (${r.sent} جهاز)`,
      'no-subscribers': 'مفيش جهاز مشترك. فعّل الإشعارات الأول.',
      'nothing-pending': 'مفيش مهام متأخرة النهاردة، فمفيش حاجة تتبعت 🎉',
      'delivery-failed': 'فشل توصيل الإشعار. جرّب تفعّل الإشعارات تاني.',
    }[r.reason];
    return toast(msg || 'تم');
  }
  readModal();
  const i = Number(el.dataset.i);
  if (act === 'm-add-ch') {
    m.channels.push({ id: m.tmp--, name: '', color: '#4f8cff', style: '', icon: '', title_prompt: '', image_prompt: '' });
    return renderModal();
  }
  if (act === 'm-del-ch') {
    const [c] = m.channels.splice(i, 1);
    if (c.id > 0) m.deletedChannels.push(c.id);
    m.tasks.forEach((t) => t.channel_id === c.id && (t.channel_id = null));
    return renderModal();
  }
  if (act === 'm-add-task') {
    const day = el.dataset.day === 'none' || el.dataset.day === undefined ? null : Number(el.dataset.day);
    m.tasks.push({ title: m.channels[0]?.name || '', channel_id: m.channels[0]?.id ?? null, day, is_video: true });
    const newIndex = m.tasks.length - 1;
    renderModal();
    return $(`[data-tk="${newIndex}"] [data-k="channel"]`, $('#modalRoot'))?.focus();
  }
  if (act === 'm-del-task') {
    m.tasks.splice(i, 1);
    return renderModal();
  }
  if (act === 'm-reset') {
    const pw = $('#s_resetpw').value;
    if (!pw) return toast('اكتب كلمة السر', true);
    if (!confirm('متأكد؟ التصفير مفيش منه رجوع.')) return;
    await api('/reset', { method: 'POST', body: { password: pw } });
    closeModal();
    state.open.clear();
    await load();
    return toast('🔒 اتصفّر الأسبوع الحالي');
  }
  if (act === 'm-save') return saveSettings();
}

async function saveSettings() {
  const m = state.modal;
  if (m.channels.some((c) => !c.name.trim())) return toast('كل قناة لازم يكون ليها اسم', true);
  if (m.tasks.some((t) => !t.channel_id || !m.channels.some((c) => c.id === t.channel_id && c.name.trim()))) return toast('اختار قناة لكل مهمة', true);
  if (m.settings.weekStartDay !== state.data.settings.weekStartDay) {
    if (!confirm('تغيير يوم بداية الأسبوع هيبدأ أسبوع جديد بحدود جديدة. متأكد؟')) return;
  }
  const btn = $('[data-act="m-save"]');
  btn.disabled = true;
  try {
    const tasks = m.tasks.map((t) => ({
      id: t.id > 0 ? t.id : undefined,
      channel_id: t.channel_id,
      title: t.title.trim(),
      day: t.day,
      is_video: t.is_video,
    }));
    await api('/workspace', {
      method: 'PUT',
      body: {
        settings: m.settings,
        channels: m.channels.map((channel) => ({ ...channel, name: channel.name.trim() })),
        tasks,
        deletedChannels: m.deletedChannels,
      },
    });
    closeModal();
    await load();
    toast('✅ الإعدادات اتحفظت');
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
  }
}

// ───────────── التشغيل ─────────────
(async function init() {
  try {
    await load();
  } catch (e) {
    toast(e.message, true);
  }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  updateNotifyBtn().catch(() => {});
  // تحديث دوري عشان "النهاردة" تفضل صح لو الصفحة فضلت مفتوحة
  setInterval(() => {
    if (!state.modal && !state.busy.size && !document.hidden) guarded(() => load());
  }, 5 * 60 * 1000);
})();
