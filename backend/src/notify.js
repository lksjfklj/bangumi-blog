// notify.js - 失败/告警通知（Server酱 / Telegram / 通用 Webhook，未配置则静默）
// .env 配置：
//   NOTIFY_SERVERCHAN_KEY=xxx                    # Server酱 SendKey（sctapi.ftqq.com）
//   NOTIFY_TELEGRAM_BOT_TOKEN=xxx                # Telegram Bot Token
//   NOTIFY_TELEGRAM_CHAT_ID=xxx                  # 接收消息的 chat_id（支持 -100 群组）
//   NOTIFY_WEBHOOK=https://example.com/hook      # 通用 Webhook，POST JSON {title, body}
const config = require('./config');

function enabled() {
  return !!(config.notify && (
    config.notify.serverchanKey || config.notify.telegramBotToken || config.notify.webhook
  ));
}

function describe() {
  const parts = [];
  if (config.notify && config.notify.serverchanKey) parts.push('serverchan');
  if (config.notify && config.notify.telegramBotToken) parts.push('telegram');
  if (config.notify && config.notify.webhook) parts.push('webhook');
  return parts.length ? parts.join('+') : '未配置';
}

let inflight = Promise.resolve();
async function notify(title, body = '') {
  if (!enabled()) return false;
  const payload = {
    title: String(title).slice(0, 200),
    body: String(body).slice(0, 3000)
  };
  const run = async () => {
    let ok = false;
    const c = config.notify || {};
    if (c.serverchanKey) {
      try {
        const u = new URL('https://sctapi.ftqq.com/' + encodeURIComponent(c.serverchanKey) + '.send');
        u.searchParams.set('title', payload.title);
        u.searchParams.set('desp', payload.body);
        const res = await fetch(u.href, { method: 'POST', signal: AbortSignal.timeout(10000) });
        ok = res.ok || ok;
      } catch (e) { console.error('[notify] serverchan fail:', e.message); }
    }
    if (c.telegramBotToken && c.telegramChatId) {
      try {
        const text = '<b>' + payload.title + '</b>\n' + payload.body.slice(0, 2500);
        const res = await fetch('https://api.telegram.org/bot' + c.telegramBotToken + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: c.telegramChatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
          signal: AbortSignal.timeout(10000)
        });
        ok = res.ok || ok;
      } catch (e) { console.error('[notify] telegram fail:', e.message); }
    }
    if (c.webhook) {
      try {
        const res = await fetch(c.webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000)
        });
        ok = res.ok || ok;
      } catch (e) { console.error('[notify] webhook fail:', e.message); }
    }
    return ok;
  };
  // 串行发送，避免并发把推送通道打爆
  const p = inflight.then(run, run);
  inflight = p.catch(() => {});
  return p;
}

module.exports = { notify, enabled, describe };
