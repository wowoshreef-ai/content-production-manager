import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { openDb } from '../server/store.js';
import { seedDemo } from '../server/seed.js';

// الثلاثاء 27 أكتوبر 2026، الساعة 12 الضهر بتوقيت القاهرة تقريبًا
export const NOW = new Date('2026-10-27T09:00:00Z');
export const WEEK_START = '2026-10-24'; // السبت

/** بيشغّل سيرفر حقيقي على بورت عشوائي بقاعدة بيانات في الذاكرة */
export async function startTestServer({ env = {}, now = NOW, fetchImpl, seed = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-test-'));
  const db = openDb(':memory:');
  if (seed) seedDemo(db);
  const sent = [];
  const pushSender = async (sub, payload) => {
    sent.push({ sub, payload: JSON.parse(payload) });
  };
  let clock = now;
  const { app, push } = createApp({
    db,
    env: { RESET_PASSWORD: 'test-pass', ...env },
    dataDir,
    now: () => clock,
    fetchImpl,
    pushSender,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* مش JSON */
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  return {
    base,
    db,
    push,
    sent,
    dataDir,
    call,
    get: (u, h) => call('GET', u, undefined, h),
    post: (u, b) => call('POST', u, b ?? {}),
    put: (u, b) => call('PUT', u, b),
    patch: (u, b) => call('PATCH', u, b),
    del: (u) => call('DELETE', u),
    setNow: (d) => (clock = d),
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          fs.rmSync(dataDir, { recursive: true, force: true });
          resolve();
        });
        server.closeAllConnections?.();
      }),
  };
}

/** fetch وهمي بيرجّع JSON ثابت ويسجّل الطلبات */
export function mockFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const { status = 200, body } = await responder(String(url), init);
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  fn.calls = calls;
  return fn;
}
