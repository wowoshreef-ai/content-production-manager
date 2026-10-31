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

async function api(path, { method = 'GET', body, keepalive } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      keepalive,
    });
  } catch {
    setOnline(false);
    throw new Error('مفيش اتصال بالسيرفر');
  }
  setOnline(true);
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* مفيش body */
  }
  if (!res.ok) throw new Error(json?.error || `حصل خطأ (${res.status})`);
  return json;
}

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
const autosizeAll = () => $$('textarea.auto').forEach(autosize);

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
  state.data = await api('/state');
  state.bank = await api('/bank');
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
const noteFlag = (e) => `<span class="flag written" data-nflag="${e.id}"${hasNotes(e) ? '' : ' hidden'}>✅ تمت كتابة ملاحظة</span>`;
const pageIs = () => (location.hash === '#/scripts' ? 'scripts' : 'week');

function render() {
  const d = state.data;
  if (!d) return;
  const snap = captureFocus();
  $('#subtitle').textContent = d.channels.length ? d.channels.map((c) => c.name).join(' · ') : 'ضيف قنواتك من الإعدادات';
  let dismissed = false;
  try {
    dismissed = localStorage.getItem('demoDismissed') === '1';
  } catch {
    /* التخزين مش متاح */
  }
  $('#demoBanner').hidden = !(d.demo && !dismissed);
  const scripts = pageIs() === 'scripts';
  $('#progress').hidden = scripts;
  const nav = $('#navLink');
  if (nav) {
    nav.textContent = scripts ? '📅 جدول الأسبوع' : '✍️ السكريبتات';
    nav.setAttribute('href', scripts ? '#/' : '#/scripts');
  }
  document.title = scripts ? 'السكريبتات — مدير إنتاج المحتوى' : 'مدير إنتاج المحتوى';
  const keep = { t: $('#bankTitle')?.value, b: $('#bankBody')?.value };
  if (!scripts) renderProgress();
  $('#view').innerHTML = scripts ? scriptsView() : weekView();
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
  return `<section class="day${isToday ? ' today' : ''}${complete ? ' complete' : ''}"${wd === null ? '' : ` data-wd="${wd}"`}>
    <h3 class="group-title">${title}${isToday ? '<span class="today-tag">النهاردة</span>' : ''}${complete ? '<span class="done-tag">✓ اليوم اكتمل</span>' : ''}${small ? ` <small>${small}</small>` : ''}${entries.length ? `<span class="day-bar"><i style="width:${Math.round((doneN / entries.length) * 100)}%"></i></span><small class="count">${doneN}/${entries.length}</small>` : ''}</h3>
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
  let html = weekStrip();
  for (let i = 0; i < 7; i++) {
    const wd = (start + i) % 7;
    const mine = d.entries.filter((e) => e.day === wd);
    const off = d.settings.workDays.includes(wd) ? '' : ' · إجازة';
    html += dayGroup(DAYS[wd], fmtDay(addDaysStr(d.weekStart, i)) + off, mine, wd === d.todayWeekday, true, wd);
  }
  html += dayGroup('📋 من غير يوم محدد', '', d.entries.filter((e) => e.day === null), false, false);
  if (!d.entries.length) html += '<div class="empty">مفيش مهام. ضيف مهام من ⚙️ الإعدادات أو أضف فيديو إضافي تحت.</div>';
  html += `<div class="box" style="margin-top:16px">
      <h4>➕ فيديو إضافي للأسبوع ده (بونص)</h4>
      <div class="row">
        <select id="extraChannel" style="width:auto">${d.channels.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
        <input type="text" id="extraTitle" class="grow" placeholder="اسم الفيديو الإضافي" maxlength="300">
        <button class="btn" data-act="add-extra" type="button">إضافة</button>
      </div>
    </div>`;
  html += '<div class="reset-row"><button class="btn ghost" data-act="open-reset" type="button">🔒 إعادة تعيين الجدول بالكامل</button></div>';
  return html;
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
      ${ch ? `<span class="badge" style="--c:${esc(ch.color)}">${chLabel(ch)}</span>` : ''}
      <div class="t-title" data-act="toggle" data-id="${e.id}">${esc(e.title)}${e.chosen_title ? `<small>🎯 ${esc(e.chosen_title)}</small>` : ''}</div>
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
    <div class="row">
      <div class="grow"><label class="lbl">اسم المهمة</label>
        <input type="text" data-id="${e.id}" data-field="title" value="${esc(e.title)}" maxlength="300"></div>
      <div><label class="lbl">القناة</label>
        <select data-id="${e.id}" data-field="channel_id"><option value="">— من غير قناة —</option>
          ${d.channels.map((c) => `<option value="${c.id}" ${c.id === e.channel_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div><label class="lbl">اليوم</label>
        <select data-id="${e.id}" data-field="day"><option value="">أي يوم</option>
          ${DAYS.map((n, i) => `<option value="${i}" ${e.day === i ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    </div>
    <div class="row">
      <label><input type="checkbox" data-id="${e.id}" data-field="is_video" ${e.is_video ? 'checked' : ''}> فيديو (بيتحسب في هدف الـ ${d.progress.target})</label>
      <button class="btn small danger" data-act="delete" data-id="${e.id}" type="button">🗑️ حذف المهمة</button>
    </div>

    <div class="cols">
      <div><label class="lbl">✍️ السكريبت</label>
        <textarea class="auto" data-id="${e.id}" data-field="script" placeholder="اكتب السكريبت هنا… الخانة بتكبر لوحدها">${esc(e.script)}</textarea></div>

      <div><label class="lbl">📝 ملاحظات وروابط ${noteFlag(e)}</label>
        <textarea class="auto" data-id="${e.id}" data-field="notes" placeholder="اكتب أي ملحوظة أو الصق أي رابط (مرجع، مصدر، فيديو…)">${esc(e.notes)}</textarea>
        <ul class="links">${linksHtml(e.notes)}</ul></div>
    </div>

    <div class="box"><h4>✨ العناوين بالذكاء الاصطناعي</h4>
      <div class="row">
        <select data-prov style="width:auto">
          <option value="auto" ${chosenProvider === 'auto' ? 'selected' : ''}>تلقائي</option>
          ${['anthropic', 'gemini', 'openai']
            .filter((p) => providers.includes(p))
            .map((p) => `<option value="${p}" ${chosenProvider === p ? 'selected' : ''}>${{ anthropic: 'Claude', gemini: 'Gemini', openai: 'OpenAI' }[p]}</option>`)
            .join('')}
        </select>
        <button class="btn small" data-act="titles" data-id="${e.id}" type="button" ${busyT ? 'disabled' : ''}>${busyT ? '⏳ بيكتب…' : e.titles.length ? '🔄 ولّد تاني' : '✨ ولّد العناوين'}</button>
      </div>
      ${providers.length ? '' : '<p class="hint">محتاج مفتاح ذكاء اصطناعي في ملف .env (ANTHROPIC_API_KEY أو GEMINI_API_KEY أو OPENAI_API_KEY).</p>'}
      <div class="titles">${e.titles
        .map(
          (t, i) => `<div class="row"><button class="title-opt grow ${t === e.chosen_title ? 'picked' : ''}" data-act="pick-title" data-id="${e.id}" data-i="${i}" type="button">${t === e.chosen_title ? '✅ ' : ''}${esc(t)}</button>
            <button class="btn small ghost" data-act="copy-title" data-id="${e.id}" data-i="${i}" type="button">📋</button></div>`,
        )
        .join('')}</div>
    </div>

    <div class="box"><h4>🖼️ الصورة المصغرة</h4>
      <label class="lbl">البرومبت (بيتكتب تلقائي من العنوان وأسلوب القناة — عدّله لو عايز)</label>
      <textarea class="auto short" data-id="${e.id}" data-field="thumb_prompt" dir="auto">${esc(e.thumb_prompt || e.suggested_thumb_prompt)}</textarea>
      <div class="row" style="margin-top:8px">
        <button class="btn small" data-act="flow" data-id="${e.id}" type="button">📋 انسخ الوصف وافتح Flow</button>
      </div>
      <p class="hint">هننسخ الوصف ونفتح Google Flow؛ الصقه هناك واضغط إنشاء الصورة.</p>
      ${e.thumb_url ? `<div class="thumb"><img src="${esc(e.thumb_url)}" alt="الصورة المصغرة" loading="lazy"><div class="row"><a class="btn small ghost" href="${esc(e.thumb_url)}" download>⬇️ تحميل الصورة</a></div></div>` : ''}
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
    <input type="password" id="resetPw" placeholder="الباسورد" autocomplete="off" dir="ltr">
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
  const opt = (e) => `<option value="${e.id}">${esc(e.channel?.name ? `${e.channel.name} — ` : '')}${esc(e.title)}${e.script.trim() ? ' ✍️ (فيه سكريبت)' : ''}</option>`;
  const groups = weekOrder()
    .map((wd) => [DAYS[wd], d.entries.filter((e) => e.day === wd)])
    .concat([['من غير يوم', d.entries.filter((e) => e.day === null)]])
    .filter(([, list]) => list.length);
  return `<option value="">— اختار المهمة —</option>${groups.map(([name, list]) => `<optgroup label="${esc(name)}">${list.map(opt).join('')}</optgroup>`).join('')}`;
}

function scriptCard(e) {
  const ch = e.channel;
  return `<article class="task s-card ${hasScript(e) ? 'ready' : ''}" data-sid="${e.id}">
    <div class="t-head">
      ${scriptFlag(e)}
      ${ch ? `<span class="badge" style="--c:${esc(ch.color)}">${chLabel(ch)}</span>` : ''}
      <div class="t-title">${esc(e.title)}</div>
      <select data-id="${e.id}" data-field="day" title="انقل المهمة ليوم تاني"><option value="">أي يوم</option>
        ${DAYS.map((n, i) => `<option value="${i}" ${e.day === i ? 'selected' : ''}>${n}</option>`).join('')}</select>
    </div>
    <div class="t-body"><textarea class="auto" data-id="${e.id}" data-field="script" placeholder="اكتب سكريبت «${esc(e.title)}» هنا… الخانة بتكبر لوحدها">${esc(e.script)}</textarea></div>
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
  if (ev.target.classList?.contains('modal-back')) return closeModal();
  const el = ev.target.closest('[data-act]');
  if (!el || ['done', 'uploaded'].includes(el.dataset.act)) return;
  const id = Number(el.dataset.id);
  const bid = Number(el.dataset.bid);
  const act = el.dataset.act;
  guarded(async () => {
    switch (act) {
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
        const title = $('#extraTitle').value.trim();
        if (!title) return toast('اكتب اسم الفيديو الأول', true);
        const created = await api('/entries', {
          method: 'POST',
          body: { title, channel_id: Number($('#extraChannel').value) || null, week: state.data.weekStart },
        });
        state.open.add(created.id);
        return load();
      }
      case 'titles':
        return genTitles(id);
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
    return guarded(() => mutate(Number(el.dataset.id), { done: el.checked }));
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

// تحديث علامة "تم كتابة السكريبت" والعدّادات وقت الكتابة من غير إعادة رسم
function refreshScriptUi(e) {
  const on = hasScript(e);
  document.querySelectorAll(`[data-sflag="${e.id}"]`).forEach((f) => (f.hidden = !on));
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
    document.querySelectorAll(`[data-nflag="${e.id}"]`).forEach((f) => (f.hidden = !hasNotes(e)));
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
window.addEventListener('resize', autosizeAll);
window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  render();
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
const promptValue = (id) => $(`[data-id="${id}"][data-field="thumb_prompt"]`)?.value || entryById(id).suggested_thumb_prompt;

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
    btn.textContent = '🔕 الإشعارات مش مدعومة';
    return;
  }
  const sub = await currentSubscription();
  btn.textContent = sub && Notification.permission === 'granted' ? '🔔 مفعّلة (جرّبها)' : '🔔 فعّل الإشعارات';
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
  const tpl = await api('/template');
  const d = state.data;
  state.modal = {
    settings: JSON.parse(JSON.stringify(d.settings)),
    channels: d.channels.map((c) => ({ ...c })),
    tasks: tpl.map((t) => ({ ...t })),
    deletedChannels: [],
    tmp: -1,
  };
  renderModal();
}

function closeModal() {
  if (!state.modal) return;
  state.modal = null;
  $('#modalRoot').innerHTML = '';
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
  $('#modalRoot').innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-label="الإعدادات">
    <h2>⚙️ الإعدادات</h2>

    <section><h3>🎯 هدف الأسبوع وأيام الشغل</h3>
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

    <section><h3>📺 القنوات</h3>
      ${m.channels
        .map(
          (c, i) => `<div class="edit-row ch" data-ch="${i}">
            <input type="text" data-k="icon" class="icon-in" value="${esc(c.icon || '')}" placeholder="😀" maxlength="8" title="أيقونة القناة (إيموجي)">
            <input type="text" data-k="name" value="${esc(c.name)}" placeholder="اسم القناة" maxlength="60">
            <input type="color" data-k="color" value="${esc(c.color)}">
            <button class="btn small danger" data-act="m-del-ch" data-i="${i}" type="button">حذف</button>
            <textarea class="auto short" data-k="style" placeholder="أسلوب القناة (بيساعد الذكاء الاصطناعي في العناوين والصور)">${esc(c.style)}</textarea>
          </div>`,
        )
        .join('')}
      <button class="btn small ghost" data-act="m-add-ch" type="button">➕ قناة جديدة</button>
    </section>

    <section><h3>📋 قائمة المهام الأسبوعية الثابتة (${m.tasks.length})</h3>
      ${m.tasks
        .map(
          (t, i) => `<div class="edit-row" data-tk="${i}">
            <select data-k="channel">${chOpts(t.channel_id)}</select>
            <input type="text" data-k="title" value="${esc(t.title)}" placeholder="اسم المهمة / الفيديو" maxlength="300">
            <select data-k="day">${dayOpts(t.day)}</select>
            <label title="بيتحسب في هدف الفيديوهات"><input type="checkbox" data-k="video" ${t.is_video ? 'checked' : ''}> فيديو</label>
            <button class="btn small danger" data-act="m-del-task" data-i="${i}" type="button">✕</button>
          </div>`,
        )
        .join('')}
      <button class="btn small ghost" data-act="m-add-task" type="button">➕ مهمة جديدة</button>
      <p class="hint">التعديل بيتطبق على الأسبوع الحالي والأسابيع الجاية. المهام اللي خلصت أو فيها سكريبت متتمسحش.</p>
    </section>

    <section><h3>🤖 الذكاء الاصطناعي والمنصات</h3>
      <div class="row">
        <div><label class="lbl">مزوّد العناوين</label><select id="s_ai" style="width:auto">
          ${['auto', 'anthropic', 'gemini', 'openai'].map((p) => `<option value="${p}" ${s.aiProvider === p ? 'selected' : ''}>${{ auto: 'تلقائي', anthropic: 'Claude', gemini: 'Gemini', openai: 'OpenAI' }[p]}</option>`).join('')}</select></div>
        <div><label class="lbl">أبعاد الصورة المصغرة</label><select id="s_aspect" style="width:auto">
          ${['16:9', '9:16', '1:1', '4:3'].map((a) => `<option ${s.thumbAspect === a ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
        <div class="grow"><label class="lbl">المنصات (مفصولة بفاصلة)</label><input type="text" id="s_platforms" value="${esc(s.platforms.join('، '))}"></div>
      </div>
      <p class="hint">مفاتيح الـ API بتتحط في ملف .env على السيرفر — مش من هنا.</p>
    </section>

    <section class="danger-zone"><h3>🔒 تصفير الأسبوع الحالي</h3>
      <p class="hint">بيمسح علامات "تم" والسكريبتات والعناوين بتاعت الأسبوع الحالي ويبدأه من الأول. النتيجة بتتسجل في السجل.</p>
      <div class="row"><input type="password" id="s_resetpw" placeholder="كلمة السر" class="grow" autocomplete="off">
        <button class="btn small danger" data-act="m-reset" type="button">تصفير</button></div>
    </section>

    <div class="foot"><button class="btn ghost" data-act="m-close" type="button">إلغاء</button><button class="btn" data-act="m-save" type="button">💾 حفظ</button></div>
  </div></div>`;
  autosizeAll();
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
  });
  m.tasks.forEach((t, i) => {
    const row = $(`[data-tk="${i}"]`, root);
    t.channel_id = $('[data-k=channel]', row).value === '' ? null : Number($('[data-k=channel]', row).value);
    t.title = $('[data-k=title]', row).value;
    t.day = $('[data-k=day]', row).value === '' ? null : Number($('[data-k=day]', row).value);
    t.is_video = $('[data-k=video]', row).checked;
  });
}

document.addEventListener('change', (ev) => {
  // تلوين أزرار أيام الشغل لحظيًا
  const wd = ev.target.dataset?.wd;
  if (wd !== undefined) ev.target.closest('.pill').classList.toggle('on', ev.target.checked);
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
    m.channels.push({ id: m.tmp--, name: '', color: '#4f8cff', style: '', icon: '' });
    return renderModal();
  }
  if (act === 'm-del-ch') {
    const [c] = m.channels.splice(i, 1);
    if (c.id > 0) m.deletedChannels.push(c.id);
    m.tasks.forEach((t) => t.channel_id === c.id && (t.channel_id = null));
    return renderModal();
  }
  if (act === 'm-add-task') {
    m.tasks.push({ title: '', channel_id: m.channels[0]?.id ?? null, day: null, is_video: true });
    renderModal();
    const rows = $$('[data-tk]');
    return rows.at(-1)?.querySelector('[data-k=title]')?.focus();
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
  if (m.tasks.some((t) => !t.title.trim())) return toast('كل مهمة لازم يكون ليها اسم', true);
  if (m.settings.weekStartDay !== state.data.settings.weekStartDay) {
    if (!confirm('تغيير يوم بداية الأسبوع هيبدأ أسبوع جديد بحدود جديدة. متأكد؟')) return;
  }
  const btn = $('[data-act="m-save"]');
  btn.disabled = true;
  try {
    const idMap = new Map();
    for (const c of m.channels) {
      const body = { name: c.name.trim(), color: c.color, style: c.style, icon: c.icon || '' };
      if (c.id > 0) await api(`/channels/${c.id}`, { method: 'PATCH', body });
      else idMap.set(c.id, (await api('/channels', { method: 'POST', body })).id);
    }
    for (const id of m.deletedChannels) await api(`/channels/${id}`, { method: 'DELETE' });
    const tasks = m.tasks.map((t) => ({
      id: t.id > 0 ? t.id : undefined,
      channel_id: idMap.get(t.channel_id) ?? t.channel_id,
      title: t.title.trim(),
      day: t.day,
      is_video: t.is_video,
    }));
    await api('/template', { method: 'PUT', body: { tasks } });
    await api('/settings', { method: 'PUT', body: m.settings });
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
