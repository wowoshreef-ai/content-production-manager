import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { listPushSubscriptions, removePushSubscription } from './store.js';

/** بيحمّل مفاتيح VAPID من البيئة أو من data/vapid.json، ولو مش موجودة بيولّدها أول مرة */
function loadVapid(env, dataDir) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  }
  const file = path.join(dataDir, 'vapid.json');
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (k.publicKey && k.privateKey) return k;
  } catch {
    /* هنولّد مفاتيح جديدة */
  }
  const keys = webpush.generateVAPIDKeys();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

export function createPush({ db, env, dataDir, sender }) {
  const vapid = loadVapid(env, dataDir);
  const subject = env.VAPID_SUBJECT || 'mailto:admin@example.com';
  webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
  const send = sender ?? ((sub, payload) => webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 12 }));

  return {
    publicKey: vapid.publicKey,
    async sendAll(payload) {
      const subs = listPushSubscriptions(db);
      let sent = 0;
      let failed = 0;
      for (const sub of subs) {
        try {
          await send(sub, JSON.stringify(payload));
          sent++;
        } catch (e) {
          if (e?.statusCode === 404 || e?.statusCode === 410) removePushSubscription(db, sub.endpoint);
          failed++;
        }
      }
      return { sent, failed, total: subs.length };
    },
  };
}
