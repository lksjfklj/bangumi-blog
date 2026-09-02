// pushchannels.js - 用户级「新话更新」通知分发
// 渠道：Server酱（用户自己的 SendKey）、Telegram（全局 Bot + 用户 chat_id）、
//       通用 Webhook、SMTP 邮件（全局 SMTP + 用户邮箱）、PWA Web Push
// 与 notify.js（站长失败告警）互补：这里是按用户订阅定向推送
const config = require('./config');
const webpush = require('./webpush');
const logger = require('./logger');
const { pool } = require('./db');

// 读用户通知设置 + Web Push 订阅
async function getUserNotifySettings(userId) {
  let settings = { enabled: 1, serverchan_key: '', telegram_chat_id: '', webhook: '', email: '', updated_at: 0 };
  try {
    const [rows] = await pool.query('SELECT * FROM user_notify_settings WHERE user_id = ?', [userId]);
    if (rows.length) settings = { ...settings, ...rows[0] };
  } catch (e) { /* 表不存在/失败 -> 默认关闭 */ }
  try {
    const [subs] = await pool.query('SELECT endpoint, keys FROM push_subscriptions WHERE user_id = ?', [userId]);
    settings.subscriptions = subs.map(s => {
      try { return { endpoint: s.endpoint, keys: JSON.parse(s.keys) }; } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { settings.subscriptions = []; }
  return settings;
}

// 校验用户可配置字段（白名单 + 长度/格式限制），非法字段丢弃
function sanitizeSettings(body) {
  const out = {};
  if (body && typeof body.enabled === 'boolean') out.enabled = body.enabled ? 1 : 0;
  if (typeof body.serverchan_key === 'string') {
    const v = body.serverchan_key.trim().slice(0, 64);
    if (!v || /^[A-Za-z0-9\-_]{8,64}$/.test(v)) out.serverchan_key = v;
  }
  if (typeof body.telegram_chat_id === 'string') {
    const v = body.telegram_chat_id.trim().slice(0, 32);
    if (!v || /^-?\d{4,32}$/.test(v)) out.telegram_chat_id = v;
  }
  if (typeof body.webhook === 'string') {
    const v = body.webhook.trim().slice(0, 500);
    if (!v || /^https?:\/\/.+/.test(v)) out.webhook = v;
  }
  if (typeof body.email === 'string') {
    const v = body.email.trim().slice(0, 200).toLowerCase();
    if (!v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) out.email = v;
  }
  return out;
}

// 单条消息投递给一个用户；返回每个渠道的结果
async function sendToUser(user, settings, payload) {
  const results = [];
  const title = String(payload.title || '').slice(0, 200);
  const body = String(payload.body || '').slice(0, 3000);
  const url = String(payload.url || '').slice(0, 500);
  const c = settings || {};

  // 1) Server酱（用户自己的 SendKey）
  if (c.serverchan_key) {
    try {
      const u = new URL('https://sctapi.ftqq.com/' + encodeURIComponent(c.serverchan_key) + '.send');
      u.searchParams.set('title', title);
      u.searchParams.set('desp', body + (url ? '\n\n' + url : ''));
      const res = await fetch(u.href, { method: 'POST', signal: AbortSignal.timeout(10000) });
      results.push({ channel: 'serverchan', ok: res.ok });
    } catch (e) {
      results.push({ channel: 'serverchan', ok: false, error: e.message });
    }
  }

  // 2) Telegram（全局 Bot Token + 用户 chat_id）
  if (config.notify.telegramBotToken && c.telegram_chat_id) {
    try {
      const text = '<b>' + title + '</b>\n' + body.slice(0, 2500) + (url ? '\n\n<a href="' + url + '">打开详情</a>' : '');
      const res = await fetch('https://api.telegram.org/bot' + config.notify.telegramBotToken + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: c.telegram_chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000)
      });
      results.push({ channel: 'telegram', ok: res.ok });
    } catch (e) {
      results.push({ channel: 'telegram', ok: false, error: e.message });
    }
  }

  // 3) 通用 Webhook
  if (c.webhook) {
    try {
      const res = await fetch(c.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, url }),
        signal: AbortSignal.timeout(10000)
      });
      results.push({ channel: 'webhook', ok: res.ok });
    } catch (e) {
      results.push({ channel: 'webhook', ok: false, error: e.message });
    }
  }

  // 4) SMTP 邮件（全局 SMTP + 用户邮箱）
  if (c.email && config.smtp.host) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined
      });
      await transporter.sendMail({
        from: config.smtp.from || config.smtp.user,
        to: c.email,
        subject: title,
        text: body + (url ? '\n\n' + url : ''),
        html: '<p>' + String(body).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</p>' + (url ? '<p><a href="' + url + '">打开详情</a></p>' : '')
      });
      results.push({ channel: 'email', ok: true });
    } catch (e) {
      results.push({ channel: 'email', ok: false, error: e.message });
    }
  }

  // 5) PWA Web Push
  if (Array.isArray(c.subscriptions) && c.subscriptions.length) {
    for (const sub of c.subscriptions) {
      const r = await webpush.send(sub, { title, body, url, badge: '/icons/icon-192.png', icon: '/icons/icon-192.png' });
      if (r && r.expired) {
        try { await pool.query('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [user.id, sub.endpoint]); } catch (e) { /* ignore */ }
        results.push({ channel: 'webpush', ok: false, expired: true });
      } else {
        results.push({ channel: 'webpush', ok: !!r });
      }
    }
  }

  return results;
}

// 是否配置了任何可用渠道
function hasChannels(settings) {
  if (!settings) return false;
  return !!(settings.serverchan_key || (config.notify.telegramBotToken && settings.telegram_chat_id) ||
    settings.webhook || (settings.email && config.smtp.host) ||
    (Array.isArray(settings.subscriptions) && settings.subscriptions.length));
}

module.exports = { getUserNotifySettings, sanitizeSettings, sendToUser, hasChannels };
