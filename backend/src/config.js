// config.js - 环境变量配置（支持根目录 .env 文件）
const fs = require('fs');
const path = require('path');

// 简易 .env 加载器（避免额外依赖）
try {
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  }
} catch (e) { /* 忽略 */ }

const env = process.env;

module.exports = {
  port: +(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  db: {
    file: env.DB_FILE || path.join(__dirname, '..', 'data', 'bangumi-blog.db')
  },
  bangumi: {
    clientId: env.BANGUMI_CLIENT_ID || '',
    clientSecret: env.BANGUMI_CLIENT_SECRET || '',
    redirectUri: env.BANGUMI_REDIRECT_URI || '',
    // 出口代理（本地测试走 clash，生产走服务器上的 mihomo/clash）
    proxy: env.BANGUMI_PROXY || '',
    userAgent: env.BANGUMI_USER_AGENT || 'bangumi-blog/1.0 (personal site by liyu)'
  },
  watch: {
    // 番剧 RSS 抓取出口代理（默认复用 Bangumi 代理；可用 WATCH_PROXY 单独指定）
    proxy: env.WATCH_PROXY || env.BANGUMI_PROXY || ''
  },
  // 失败告警渠道（RSS 抓取失败 / 监控异常时推送，任一配置即可）
  //   NOTIFY_SERVERCHAN_KEY=xxx              Server酱 SendKey（sctapi.ftqq.com）
  //   NOTIFY_TELEGRAM_BOT_TOKEN=xxx          Telegram Bot Token
  //   NOTIFY_TELEGRAM_CHAT_ID=xxx            接收消息 chat_id（群组 -100 开头）
  //   NOTIFY_WEBHOOK=https://example.com/hook 通用 Webhook（POST JSON {title, body}）
  notify: {
    serverchanKey: env.NOTIFY_SERVERCHAN_KEY || '',
    telegramBotToken: env.NOTIFY_TELEGRAM_BOT_TOKEN || '',
    telegramChatId: env.NOTIFY_TELEGRAM_CHAT_ID || '',
    webhook: env.NOTIFY_WEBHOOK || ''
  },
  // 站内用户「新话更新」邮件推送（可选）：配置 SMTP 后，用户可在通知设置里填自己的邮箱
  //   SMTP_HOST / SMTP_PORT / SMTP_SECURE(1) / SMTP_USER / SMTP_PASS / SMTP_FROM
  smtp: {
    host: env.SMTP_HOST || '',
    port: +(env.SMTP_PORT || 465),
    secure: env.SMTP_SECURE === '1',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || (env.SMTP_USER || '')
  },
  // Web Push（PWA 桌面/移动推送）：VAPID 密钥对自动生成并存到 data/vapid.json
  push: {
    subject: env.VAPID_SUBJECT || 'mailto:' + (env.SMTP_USER || 'admin@example.com'),
    vapidFile: env.VAPID_FILE || path.join(__dirname, '..', 'data', 'vapid.json')
  },
  // HTTPS 反代后面开启后，登录 Cookie 打 Secure 标记（COOKIE_SECURE=1）
  secureCookies: env.COOKIE_SECURE === '1',
  adminToken: env.ADMIN_TOKEN || '',
  // 站长账号：此 Bangumi UID 对应的用户拥有写权限（博客管理/只读访客模式基准）
  ownerBangumiUid: env.OWNER_BANGUMI_UID ? +env.OWNER_BANGUMI_UID : 0,
  sessionTtlMs: 30 * 24 * 3600 * 1000,
  publicBase: env.PUBLIC_BASE || 'http://8.134.187.77:8088',
  imgCacheDir: env.IMG_CACHE_DIR || path.join(__dirname, '..', 'img-cache'),
  enableBlog: env.ENABLE_BLOG !== '0',
  // Bangumi 收藏同步：全局同一时刻只跑 1 个同步任务（排队 FIFO 逐个执行）；
  // 同一用户两次同步请求之间至少间隔 BGM_SYNC_COOLDOWN_MS（默认 60 秒），防止反复触发打爆 Bangumi 配额
  bgmSyncCooldownMs: +(env.BGM_SYNC_COOLDOWN_MS || 60000),
  // 邮箱注册验证码有效期（毫秒），默认 10 分钟
  mailCodeTtlMs: +(env.MAIL_CODE_TTL_MS || 10 * 60 * 1000),
  // 只读访客（viewer）会话有效期（毫秒），默认 24 小时（普通用户会话仍为 30 天）
  viewerSessionTtlMs: +(env.VIEWER_SESSION_TTL_MS || 24 * 3600 * 1000),
  // 过期会话自动清理定时器间隔（毫秒），默认 30 分钟
  sessionCleanupIntervalMs: +(env.SESSION_CLEANUP_INTERVAL_MS || 30 * 60 * 1000)
};
