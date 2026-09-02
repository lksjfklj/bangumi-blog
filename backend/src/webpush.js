// webpush.js - PWA Web Push（VAPID 密钥自动生成，首启时写入 data/vapid.json）
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const config = require('./config');
const logger = require('./logger');

let vapidKeys = null;
let ready = false;

function ensureVapid() {
  if (ready) return vapidKeys;
  try {
    if (fs.existsSync(config.push.vapidFile)) {
      vapidKeys = JSON.parse(fs.readFileSync(config.push.vapidFile, 'utf8'));
    }
    if (!vapidKeys || !vapidKeys.publicKey || !vapidKeys.privateKey) {
      vapidKeys = webpush.generateVAPIDKeys();
      fs.mkdirSync(path.dirname(config.push.vapidFile), { recursive: true });
      fs.writeFileSync(config.push.vapidFile, JSON.stringify(vapidKeys, null, 2));
      logger.info('[webpush] VAPID keys generated', { file: config.push.vapidFile });
    }
    webpush.setVapidDetails(config.push.subject, vapidKeys.publicKey, vapidKeys.privateKey);
    ready = true;
  } catch (e) {
    ready = false;
    vapidKeys = null;
    logger.warn('[webpush] VAPID init failed', { message: e.message });
  }
  return vapidKeys;
}

function publicKey() {
  ensureVapid();
  return vapidKeys ? vapidKeys.publicKey : '';
}

function isReady() { return ready; }

// 发送一条推送；订阅已失效（404/410）时返回 { expired: true } 供调用方清理
async function send(subscription, payload) {
  ensureVapid();
  if (!ready || !subscription || !subscription.endpoint) return false;
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) return { expired: true };
    logger.warn('[webpush] send failed', { endpoint: String(subscription.endpoint || '').slice(0, 60), message: e.message });
    return false;
  }
}

module.exports = { ensureVapid, publicKey, isReady, send };
