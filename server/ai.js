import { AppError, bad } from './errors.js';

// ───────────── اختيار المزوّد ─────────────

export function configuredProviders(env) {
  const out = [];
  if (env.ANTHROPIC_API_KEY) out.push('anthropic');
  if (env.GEMINI_API_KEY) out.push('gemini');
  if (env.OPENAI_API_KEY) out.push('openai');
  return out;
}

export function pickProvider(env, requested) {
  const avail = configuredProviders(env);
  if (requested && requested !== 'auto') {
    if (!avail.includes(requested)) {
      throw bad(`مزوّد "${requested}" مش متفعّل. ضيف مفتاحه في ملف .env وأعد تشغيل السيرفر.`);
    }
    return requested;
  }
  if (env.AI_PROVIDER && avail.includes(env.AI_PROVIDER)) return env.AI_PROVIDER;
  if (!avail.length) {
    throw bad('مفيش مفتاح ذكاء اصطناعي متضاف. ضيف ANTHROPIC_API_KEY أو GEMINI_API_KEY أو OPENAI_API_KEY في ملف .env وأعد تشغيل السيرفر.');
  }
  return avail[0];
}

// ───────────── استدعاء النماذج النصية (REST مباشر، من غير SDK) ─────────────

async function httpJson(fetchImpl, url, init, label) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(90_000) });
  } catch (e) {
    throw new AppError(502, `ما قدرتش أوصل لـ${label}: ${e.name === 'TimeoutError' ? 'انتهت المهلة' : e.message}`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* مش JSON */
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || text.slice(0, 200);
    throw new AppError(502, `${label} رجّع خطأ ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return json;
}

export async function callText({ env, provider, prompt, fetchImpl = fetch }) {
  if (provider === 'anthropic') {
    const json = await httpJson(
      fetchImpl,
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
      },
      'Anthropic',
    );
    return (json?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  if (provider === 'gemini') {
    const model = env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
    const json = await httpJson(
      fetchImpl,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
      },
      'Gemini',
    );
    return (json?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('\n');
  }
  if (provider === 'openai') {
    const json = await httpJson(
      fetchImpl,
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: env.OPENAI_MODEL || 'gpt-4.1-mini', messages: [{ role: 'user', content: prompt }] }),
      },
      'OpenAI',
    );
    return json?.choices?.[0]?.message?.content ?? '';
  }
  throw bad('مزوّد الذكاء الاصطناعي مش مدعوم');
}

// ───────────── العناوين ─────────────

export function buildTitlesPrompt({ channel, entry, count }) {
  const script = (entry.script || '').trim().slice(0, 4000);
  if (channel?.title_prompt?.trim()) {
    return [
      channel.title_prompt.trim(),
      '',
      'بيانات الفيديو:',
      channel.name ? `القناة: ${channel.name}` : '',
      channel.style ? `أسلوب القناة: ${channel.style}` : '',
      `فكرة الفيديو: ${entry.title}`,
      script ? `سكريبت الفيديو:\n${script}` : 'مفيش سكريبت لسه — اكتب بناءً على فكرة الفيديو بس.',
      `المطلوب: ${count} عناوين مختلفة.`,
      'رجّع الرد كـ JSON Array من النصوص بس، من غير أي كلام تاني.',
    ].filter(Boolean).join('\n');
  }
  return [
    'إنت كاتب عناوين محترف لفيديوهات قصيرة (Reels / TikTok / Shorts) بالعربي المصري.',
    channel?.name ? `القناة: ${channel.name}` : '',
    channel?.style ? `أسلوب القناة: ${channel.style}` : '',
    `فكرة الفيديو: ${entry.title}`,
    script ? `سكريبت الفيديو:\n${script}` : 'مفيش سكريبت لسه — اكتب بناءً على فكرة الفيديو بس.',
    '',
    `اكتب ${count} عناوين مختلفة. القواعد:`,
    '- مصري طبيعي ومنطوق، من غير فصحى رسمية ومن غير لغة أخبار.',
    '- كل عنوان يبدأ بصدمة أو فضول أو صراع، ويخلّي الواحد يوقف السكرول.',
    '- أقصر من 60 حرف، ومن غير كذب أو معلومات مش في الفيديو.',
    '- من غير رموز تعبيرية كتير (إيموجي واحد على الأكتر) ومن غير هاشتاجات.',
    '',
    'رجّع الرد كـ JSON Array من النصوص بس، من غير أي كلام تاني. مثال: ["عنوان 1","عنوان 2"]',
  ]
    .filter(Boolean)
    .join('\n');
}

export function parseTitles(text, count = 5) {
  const clean = (arr) => {
    const seen = new Set();
    const out = [];
    for (const t of arr) {
      const s = String(t).replace(/^[\s\-*•\d.)٠-٩]+/, '').replace(/^["“«'`]+|["”»'`,]+$/g, '').trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out.slice(0, count);
  };
  const m = String(text).match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) {
        const r = clean(arr);
        if (r.length) return r;
      }
    } catch {
      /* نكمل بالطريقة التانية */
    }
  }
  return clean(String(text).split('\n'));
}

export async function generateTitles({ env, provider, channel, entry, count = 5, fetchImpl = fetch }) {
  const text = await callText({ env, provider, prompt: buildTitlesPrompt({ channel, entry, count }), fetchImpl });
  const titles = parseTitles(text, count);
  if (!titles.length) throw new AppError(502, 'النموذج ما رجّعش عناوين واضحة، جرّب تاني.');
  return titles;
}

// ───────────── الصور المصغرة ─────────────

export function buildThumbnailPrompt({ title, channel, script }) {
  const t = (title || '').trim();
  const headline = t.length > 40 ? `${t.slice(0, 40).trim()}…` : t;
  const topic = (script || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  if (channel?.image_prompt?.trim()) {
    return [
      channel.image_prompt.trim(),
      `Topic: ${t || 'general'}.`,
      topic ? `Context: ${topic}` : '',
      headline ? `Arabic headline text (right-to-left, correct spelling): "${headline}".` : '',
      channel?.name ? `Arabic channel: ${channel.name}.` : '',
      channel?.style ? `Brand style notes: ${channel.style}` : '',
    ].filter(Boolean).join(' ');
  }
  return [
    `Eye-catching social video thumbnail${channel?.name ? ` for the Arabic channel "${channel.name}"` : ''}.`,
    `Topic: ${t || 'general'}.`,
    topic ? `Context: ${topic}` : '',
    headline ? `Large, bold, perfectly readable Arabic headline text (right-to-left, correct spelling): "${headline}".` : '',
    'High contrast, cinematic lighting, one clear focal subject, minimal clutter, strong colors.',
    channel?.style ? `Brand style notes: ${channel.style}` : '',
    'No watermarks, no logos, no extra small text.',
  ]
    .filter(Boolean)
    .join(' ');
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * توليد صورة عن طريق Gemini API (عائلة Nano Banana — نفس موديلات الصور اللي Google Flow بيستخدمها).
 * ملاحظة: Google Flow نفسه ملوش API رسمي، فمفيش تكامل مباشر معاه هنا.
 */
export async function generateImage({ env, prompt, aspect = '16:9', fetchImpl = fetch }) {
  if (!env.GEMINI_API_KEY) {
    throw bad('توليد الصور محتاج GEMINI_API_KEY في ملف .env (من Google AI Studio) وإعادة تشغيل السيرفر.');
  }
  const model = env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
  const json = await httpJson(
    fetchImpl,
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: aspect } },
      }),
    },
    'Gemini (الصور)',
  );
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.map((p) => p.inlineData ?? p.inline_data).find((d) => d?.data);
  if (!img) throw new AppError(502, 'Gemini ما رجّعش صورة (ممكن البرومبت اترفض). عدّل البرومبت وجرّب تاني.');
  const mime = img.mimeType ?? img.mime_type ?? 'image/png';
  return { mime, ext: EXT[mime] ?? 'png', buffer: Buffer.from(img.data, 'base64') };
}
