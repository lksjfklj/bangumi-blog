// server.js - 入口
const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { initDb } = require('./db');
const { getUserBySession } = require('./auth');
const { securityHeaders, originGuard, rateLimit } = require('./security');
const logger = require('./logger');

const app = express();
app.disable('x-powered-by'); // 不暴露框架版本指纹
// 安全响应头 + CSP（放在最前面，所有响应都带上）
app.use(securityHeaders);
// gzip 压缩：1核小机带宽有限，文本/JSON/静态资源先压缩再传输（图片本身已压缩的不再处理）
app.use(compression({ threshold: 1024 }));
app.set('trust proxy', true);
app.use(cookieParser());
app.use(express.json({ limit: '8mb' }));
// 跨站写请求防护（CSRF 第二道防线：Origin/Referer 校验）
app.use(originGuard);
// /api 全局限流（1 核小机防爬/防刷，阈值宽松不影响正常使用）
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300, name: 'api' }));

// 会话注入
app.use(async (req, res, next) => {
  try {
    req.user = await getUserBySession(req.cookies.sid);
  } catch (e) { req.user = null; }
  next();
});

app.use('/api/anime', require('./routes/anime'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/collections'));
app.use('/api/blog', require('./routes/blog'));
const news = require('./routes/news');
app.use('/api/news', news.router);
const watch = require('./routes/watch');
const library = require('./library');
app.use('/api/watch', watch.router);
app.use('/api/announce', require('./routes/announce'));
app.use('/api/blog/upload', require('./routes/upload'));
app.use('/api/notify', require('./routes/notify'));
app.use('/api/watch', require('./routes/watchupdates'));
app.use('/api/blog', require('./routes/comments'));
app.use('/api', require('./routes/extras'));

// 博客上传图片静态访问
const uploadDir = path.join(__dirname, '..', 'uploads');
app.use('/api/uploads', express.static(uploadDir, { maxAge: '30d', immutable: true, fallthrough: true }));
// 资讯封面图本地缓存
const newsImgDir = path.join(__dirname, '..', 'news-img');
app.use('/api/newsimg', express.static(newsImgDir, { maxAge: '30d', immutable: true, fallthrough: true }));
app.use('/api/img', require('./routes/img'));


// ---------- SEO：博客 RSS + sitemap（放在静态托管之前，避免被 SPA fallback 吞掉） ----------
const xmlEsc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

app.get('/blog/feed.xml', async (req, res, next) => {
  try {
    const { pool } = require('./db');
    const [rows] = await pool.query(
      'SELECT slug, title, summary, content, created_at FROM posts WHERE published = 1 ORDER BY created_at DESC LIMIT 20'
    );
    const items = rows.map(p => {
      const link = config.publicBase + '/blog/' + p.slug;
      const desc = (p.summary || p.content || '').slice(0, 200);
      return '<item><title>' + xmlEsc(p.title) + '</title><link>' + xmlEsc(link) + '</link>' +
        '<guid isPermaLink="true">' + xmlEsc(link) + '</guid><description>' + xmlEsc(desc) + '</description>' +
        '<pubDate>' + new Date(p.created_at).toUTCString() + '</pubDate></item>';
    }).join('\n');
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n<channel>\n' +
      '<title>秘封俱乐部 · 博客</title>\n<link>' + xmlEsc(config.publicBase) + '</link>\n' +
      '<description>秘封俱乐部博客：二次元随笔、追番记录与动画漫游指南</description>\n<language>zh-CN</language>\n' +
      items + '\n</channel>\n</rss>';
    res.type('application/rss+xml').send(xml);
  } catch (e) { next(e); }
});

app.get('/sitemap.xml', async (req, res, next) => {
  try {
    const { pool } = require('./db');
    const [rows] = await pool.query('SELECT slug, updated_at FROM posts WHERE published = 1');
    const today = new Date().toISOString().slice(0, 10);
    const locs = ['/', '/anime', '/watch', '/collection', '/blog', '/about', '/stats']
      .map(p => '<url><loc>' + xmlEsc(config.publicBase + p) + '</loc><lastmod>' + today + '</lastmod></url>');
    for (const r of rows) {
      const mod = r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 10) : today;
      locs.push('<url><loc>' + xmlEsc(config.publicBase + '/blog/' + r.slug) + '</loc><lastmod>' + mod + '</lastmod></url>');
    }
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      locs.join('\n') + '\n</urlset>';
    res.type('application/xml').send(xml);
  } catch (e) { next(e); }
});

// 健康检查：汇总各抓取模块状态 + 数据库连通性 + 进程信息（供 UptimeRobot 等外部监控）
app.get('/api/health', async (req, res, next) => {
  try {
    const { pool } = require('./db');
    let dbOk = false;
    try {
      const [rows] = await pool.query('SELECT 1 AS ok');
      dbOk = !!(rows && rows[0] && rows[0].ok === 1);
    } catch (e) { dbOk = false; }
    const [newsS, watchS, libS] = await Promise.all([
      Promise.resolve(news.getStatus ? news.getStatus() : null),
      Promise.resolve(watch.getStatus ? watch.getStatus() : null),
      Promise.resolve(library.getStatus ? library.getStatus() : null)
    ]);
    const problems = [];
    if (!dbOk) problems.push('db');
    if (newsS && newsS.lastError) problems.push('news:' + newsS.lastError);
    if (watchS && watchS.lastError) problems.push('watch:' + watchS.lastError);
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: problems.length === 0,
      time: Date.now(),
      uptime: Math.floor(process.uptime()),
      process: { pid: process.pid, memMB: Math.round(process.memoryUsage().rss / 1048576) },
      db: dbOk ? 'ok' : 'error',
      modules: { news: newsS, watch: watchS, library: libS },
      problems
    });
  } catch (e) { next(e); }
});

// 静态前端
const dist = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(dist)) {
  // index.html 必须禁用缓存，否则部署新版本后用户浏览器会一直用旧页面；带 hash 的静态资源可长缓存
  app.use(express.static(dist, {
    index: 'index.html',
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (/\.(js|css|png|jpe?g|webp|gif|svg|woff2?|ico)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      }
    }
  }));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(dist, 'index.html'));
  });
}

// 错误处理
// API 404：统一返回 JSON，避免泄漏 express 默认 HTML 路由信息
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在', status: 404 }));

// 错误处理：4xx 保留可读提示；5xx 只回通用信息，细节仅留在服务端日志
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    logger.error('[error]', { method: req.method, url: req.originalUrl, message: err.message, stack: String(err.stack || '').split('\n')[1] || '' });
    return res.status(500).json({ error: '服务器内部错误，请稍后再试', status: 500 });
  }
  res.status(status).json({ error: err.message || '请求错误', status });
});

(async () => {
  try {
    await initDb();
    logger.info('[db] schema ready');
  } catch (e) {
    logger.error('[db] init failed', { message: e.message });
  }
  logger.cleanupOld();
  news.startScheduler();
  watch.startScheduler();
  require('./updatepusher').start();

  library.startScheduler();
  require('./releasecal').startScheduler(); // Galgame 新作发售日历（VNDB）：启动 20s 后首扫 + 每 6h 增量
  app.listen(config.port, config.host, () => {
    logger.info('[server] listening', { port: config.port, host: config.host, node: process.version });
  });
})();
