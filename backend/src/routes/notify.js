// routes/notify.js - 用户「新话更新」通知设置 + PWA Web Push 订阅
// 与 routes/watch.js 的 my-updates/updates 端点配合：
//  - GET  /api/notify/settings            当前用户设置 + VAPID 公钥
//  - PUT  /api/notify/settings            更新渠道配置
//  - POST /api/notify/push-subscribe      保存 Web Push 订阅
//  - DELETE /api/notify/push-subscribe    删除订阅
//  - POST /api/notify/test                给自己发一条测试推送
const express = require('express');
const { requireNotViewer } = require('../auth');
const { pool } = require('../db');
const webpush = require('../webpush');
const { getUserNotifySettings, sanitizeSettings, sendToUser, hasChannels } = require('../pushchannels');
const logger = require('../logger');
const router = express.Router();

router.use(requireNotViewer);

// 测试推送限流：每用户 15 秒最多 1 次（进程内存，仅防手滑刷屏）
const testRateMap = new Map();
function checkTestRate(userId) {
  const now = Date.now();
  const last = testRateMap.get(userId) || 0;
  if (now - last < 15000) return Math.ceil((last + 15000 - now) / 1000);
  testRateMap.set(userId, now);
  return 0;
}

router.get('/settings', async (req, res, next) => {
  try {
    const s = await getUserNotifySettings(req.user.id);
    res.json({
      enabled: s.enabled !== 0,
      serverchan_key: s.serverchan_key || '',
      telegram_chat_id: s.telegram_chat_id || '',
      webhook: s.webhook || '',
      email: s.email || '',
      subscribed: (s.subscriptions || []).length > 0,
      vapidPublicKey: webpush.publicKey() || '',
      hasChannels: hasChannels(s),
      telegramAvailable: !!(require('../config').notify.telegramBotToken),
      smtpAvailable: !!(require('../config').smtp.host)
    });
  } catch (e) { next(e); }
});

router.put('/settings', async (req, res, next) => {
  try {
    const clean = sanitizeSettings(req.body || {});
    const cur = await getUserNotifySettings(req.user.id);
    const nextS = { ...cur, ...clean };
    const enabled = nextS.enabled !== 0 ? 1 : 0;
    await pool.query(
      `INSERT INTO user_notify_settings (user_id, enabled, serverchan_key, telegram_chat_id, webhook, email, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, serverchan_key = excluded.serverchan_key,
         telegram_chat_id = excluded.telegram_chat_id, webhook = excluded.webhook, email = excluded.email, updated_at = excluded.updated_at`,
      [req.user.id, enabled, nextS.serverchan_key || '', nextS.telegram_chat_id || '', nextS.webhook || '', nextS.email || '', Date.now()]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 保存浏览器 Web Push 订阅
router.post('/push-subscribe', async (req, res, next) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint)) {
      return res.status(400).json({ error: '订阅信息无效' });
    }
    if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
      return res.status(400).json({ error: '订阅密钥缺失' });
    }
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys) VALUES (?, ?, ?)
       ON CONFLICT(user_id, endpoint) DO UPDATE SET keys = excluded.keys`,
      [req.user.id, endpoint.slice(0, 1000), JSON.stringify({ p256dh: keys.p256dh.slice(0, 300), auth: keys.auth.slice(0, 300) })]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/push-subscribe', async (req, res, next) => {
  try {
    const endpoint = String((req.body || {}).endpoint || '').slice(0, 1000);
    if (endpoint) {
      await pool.query('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [req.user.id, endpoint]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 给自己发测试推送
router.post('/test', async (req, res, next) => {
  try {
    const rateWait = checkTestRate(req.user.id);
    if (rateWait > 0) return res.status(429).json({ error: '测试推送过于频繁，请稍后再试', retryAfterSec: rateWait });
    const s = await getUserNotifySettings(req.user.id);
    const results = await sendToUser(req.user, s, {
      title: '🔔 新话推送测试',
      body: '如果你收到了这条消息，说明「新话更新」通知渠道配置正常。',
      url: '/collection'
    });
    res.json({ ok: results.some(r => r.ok), results });
  } catch (e) { logger.error('[notify] test failed', { message: e.message }); next(e); }
});

module.exports = router;
