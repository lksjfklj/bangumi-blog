// routes/news.js - 二次元行业资讯聚合（RSS 定时抓取，SQLite 存储）
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetch, ProxyAgent } = require('undici');
const { pool } = require('../db');
const { shrinkCover } = require('../imgutil');
const { requireOwner } = require('../auth');
const router = express.Router();
const config = require('../config');

// 出口代理（服务器 mihomo/clash）：与 watch 模块一致，国外源统一走代理
let dispatcher = null;
if (config.bangumi.proxy) dispatcher = new ProxyAgent(config.bangumi.proxy);

// fetch 封装：未配置代理时不传 dispatcher（undici 不允许 null dispatcher）
async function fetchVia(url, opts = {}, direct) {
  if (!direct && dispatcher) opts.dispatcher = dispatcher;
  return fetch(url, opts);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// 资讯源：优先权威 / 更新快 / 服务器可直连
// 资讯源：限定 Galgame/视觉小说 + 动画/漫画/轻小说领域
// 专门站（bugbug/fuwanovel/animecorner）内容天然贴合领域，全量收录；
// 综合站（gcores）通过关键词过滤出目标领域文章。
const SOURCES = [
  {
    key: 'gcores',
    name: '机核 GCORES',
    lang: 'zh',
    emoji: '🎮',
    url: 'https://www.gcores.com/rss',
    desc: '中文动画/漫画/游戏文化媒体（领域过滤）',
    includeKeywords: [
      // Galgame / 视觉小说
      'galgame', 'gal game', 'visual novel', '视觉小说', '美少女游戏', '恋爱游戏', 'avg', 'adv',
      // 动画
      '动画', 'anime', '新番', '剧场版', 'ova', '放送', '声优', '配音', '制片', '作画',
      // 漫画
      '漫画', 'manga', '单行本', '连载', '漫改', '漫画家', '条漫',
      // 轻小说
      '轻小说', 'light novel', '文库', '小说化', 'web小说',
      // 二次元相关
      '手办', 'figure', '周边', '二次元', 'cosplay', '同人', '圣地巡礼', '漫展', 'bilibili',
      '京都动画', 'ufotable', '新海诚', '宫崎骏', '吉卜力'
    ],
    excludeKeywords: [
      'steam', 'ps5', 'xbox', 'switch', 'nintendo', '显卡', 'gpu', '处理器', '硬件',
      '数据泄露', '黑客', '英伟达', 'nvidia', 'amd', '销量', 'gamescom', '科隆游戏展',
      'tga', '电竞', 'esports', '赛事', '直播', 'vr', '独立游戏', 'indie', '射击', 'fps'
    ]
  },
  {
    key: 'bugbug',
    name: 'BugBug',
    lang: 'ja',
    emoji: '💗',
    url: 'https://www.bugbug.news/feed/',
    desc: '日本权威 Galgame 杂志（美少女游戏专门）'
  },
  {
    key: 'fuwanovel',
    name: 'Fuwanovel',
    lang: 'en',
    emoji: '📚',
    url: 'https://fuwanovel.net/feed',
    desc: '英文视觉小说/Galgame 资讯站',
    apiUrl: 'https://fuwanovel.moe/wp-json/wp/v2/posts?per_page=30&_embed=1',
    direct: true // fuwanovel.moe 对代理出口 IP 403，服务器直连可用
  },
  {
    key: 'animecorner',
    name: 'Anime Corner',
    lang: 'en',
    emoji: '📺',
    url: 'https://animecorner.me/feed/',
    desc: '英文动画资讯站',
    scrapeCover: true
  },
  {
    key: 'animeuknews',
    name: 'Anime UK News',
    lang: 'en',
    emoji: '🎌',
    url: 'https://animeuknews.net/feed/',
    desc: '英文动画/漫画新闻与评测',
    scrapeCover: true
  },
  {
    key: 'gematsu',
    name: 'Gematsu',
    lang: 'en',
    emoji: '🍙',
    url: 'https://www.gematsu.com/feed',
    desc: '日本游戏资讯（视觉小说/动画/漫画领域过滤）',
    scrapeCover: true,
    includeKeywords: [
      'visual novel', 'galgame', 'gal game', 'otome', 'dating sim', 'eroge',
      'anime adaptation', 'anime', 'manga', 'light novel', 'voice actor', 'seiyuu',
      'key', 'visualarts', 'type-moon', 'fate', 'steins;gate', 'higurashi', 'umineko',
      'clannad', 'air', 'kanon', 'little busters', 'planetarian', 'summer pockets'
    ],
    excludeKeywords: [
      'steam deck', 'ps5', 'xbox', 'playstation 5', 'nvidia', 'amd', 'gpu',
      'sales', 'hardware', 'firmware', 'gameplay', 'boss battle', 'walkthrough', 'mod'
    ]
  }
];

const MAX_KEEP = 3000;          // 数据库最多保留条数
const MAX_SCRAPE_PER_RUN = 10;  // 单源每次抓取最多补抓的 og:image 数量（1核小机限流）
const FETCH_TIMEOUT = 15000;    // 单源抓取超时
const INTERVAL_MS = 30 * 60 * 1000; // 30 分钟一次（1核小机负载很低）
const newsImgDir = path.join(__dirname, '..', '..', 'news-img'); // 封面图本地缓存

let running = false;
let lastRunAt = 0;
let lastError = '';

// ---------- 工具 ----------
function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch (e) { return ''; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return ''; } })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&middot;/g, '·')
    .replace(/&copy;/g, '©')
    .replace(/&#169;/g, '©');
}

function stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<!\[CDATA\[|\]\]>/g, ' ') // 先去掉 CDATA 标记，避免 <[^>]+> 贪婪吞掉正文
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFirstImg(s) {
  if (!s) return '';
  const m = String(s).match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function truncate(s, n) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// 清洗摘要中的页脚版权等噪音
function cleanSummary(s) {
  let t = String(s || '').trim();
  t = t.replace(/\s*Copyright\s*(?:&copy;|©)?\s*[\d]{4}.*?All Rights Reserved\.?\s*$/i, ' ');
  t = t.replace(/\s*\(c\)\s*[\d]{4}.*$/i, ' ');
  t = t.replace(/\s*（[^）]*）\s*$/i, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// 关键词匹配：拉丁词整词匹配（避免 avg/adv 误伤 average/advanced），中文直接包含
function keywordMatches(hay, keywords) {
  if (!Array.isArray(keywords) || !keywords.length) return false;
  return keywords.some(k => {
    const s = String(k).trim().toLowerCase();
    if (!s) return false;
    if (/^[a-z0-9][a-z0-9 .\-']*$/.test(s)) {
      const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      return new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])', 'i').test(hay);
    }
    return hay.includes(s);
  });
}

function parseRfc822(d) {
  const t = Date.parse(String(d || '').replace('GMT', 'UTC'));
  return isNaN(t) ? '' : new Date(t).toISOString();
}

function xmlField(xml, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

// 封面图下载到服务器本地缓存（避免用户网络无法直连国外/云图源）
async function localizeCover(url, direct) {
  try {
    if (!url) return '';
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return url;
    let ext = (path.extname(u.pathname) || '.jpg').toLowerCase();
    if (!/\.(png|jpe?g|webp|gif)$/i.test(ext)) ext = '.jpg';
    const key = crypto.createHash('md5').update(url).digest('hex');
    const file = path.join(newsImgDir, key + ext);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return '/api/newsimg/' + key + ext;
    fs.mkdirSync(newsImgDir, { recursive: true });
    const res = await fetchVia(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': UA } }, direct);
    if (!res.ok) return url;
    let buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return url;
    // 大图缩到 640px 再落盘：新闻封面动辄 1-6MB，缩略后通常只剩 50-100KB
    const shrunk = await shrinkCover(buf, ext);
    buf = shrunk.buf; ext = shrunk.ext;
    const outFile = path.join(newsImgDir, key + ext);
    fs.writeFileSync(outFile, buf);
    return '/api/newsimg/' + key + ext;
  } catch (e) { return url; }
}


// RSS 无封面时：1) 源站 REST API 批量取 featured media 2) 抓文章页 og:image（限流）
async function fetchApiCovers(src) {
  if (!src.apiUrl) return new Map();
  try {
    const res = await fetchVia(src.apiUrl, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT)
    }, src.direct);
    if (!res.ok) return new Map();
    const list = await res.json();
    const map = new Map();
    for (const p of Array.isArray(list) ? list : []) {
      const img = (p._embedded && p._embedded['wp:featuredmedia'] && p._embedded['wp:featuredmedia'][0] && p._embedded['wp:featuredmedia'][0].source_url) || '';
      if (p.link && img) map.set(String(p.link).replace(/\/$/, '').toLowerCase(), img);
    }
    return map;
  } catch (e) { return new Map(); }
}

async function fetchOgImage(url, direct) {
  try {
    const res = await fetchVia(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000), redirect: 'follow' }, direct);
    if (!res.ok) return '';
    const html = await res.text();
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

// ---------- 抓取 ----------
async function fetchOne(src) {
  let scrapedCount = 0;
  const apiCovers = await fetchApiCovers(src);
  const res = await fetchVia(src.url, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT)
  }, src.direct);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const xml = await res.text();
  const items = [];
  const re = /<item[\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[0];
    const title = decodeEntities(stripHtml(xmlField(block, 'title')));
    const link = xmlField(block, 'link').trim();
    if (!title || !link) continue;
    let description = xmlField(block, 'description');
    if (!description && /<content:encoded/.test(block)) description = xmlField(block, 'content:encoded');
    // 领域过滤：综合源只保留目标领域文章
    if (src.includeKeywords && src.includeKeywords.length) {
      const hay = (title + ' ' + stripHtml(decodeEntities(description))).toLowerCase();
      if (!keywordMatches(hay, src.includeKeywords)) continue;
      if (src.excludeKeywords && keywordMatches(hay, src.excludeKeywords)) continue;
    }
    let cover = '';
    if (src.key === 'gcores') cover = extractFirstImg(description);
    else cover = extractFirstImg(description) || extractFirstImg(xmlField(block, 'content:encoded'));
    if (!cover) cover = apiCovers.get(String(link).replace(/\/$/, '').toLowerCase()) || '';
    if (!cover && src.scrapeCover && scrapedCount < MAX_SCRAPE_PER_RUN) { scrapedCount++; cover = await fetchOgImage(link, src.direct); }
    let text = stripHtml(decodeEntities(description)); // 先解码实体/去 CDATA，再剥标签
    text = cleanSummary(text);
    const summary = truncate(text, 200);
    if (summary.length < 10) continue; // 摘要过短（如仅剩版权行）视为无效条目
    const pub = parseRfc822(xmlField(block, 'pubDate')) || new Date().toISOString();
    items.push({ source: src.key, title, summary, link, cover, published_at: pub });
  }
  if (!items.length) { console.warn('[news] ' + src.key + ': 0 条符合领域过滤，本次跳过'); return 0; }
  // 入库（去重）
  for (const it of items) {
    try {
      it.cover = await localizeCover(it.cover, src.direct);
      await pool.query(
        `INSERT OR IGNORE INTO news (source, title, summary, link, cover, published_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [it.source, it.title, it.summary, it.link, it.cover, it.published_at]
      );
    } catch (e) { /* 单条失败不影响整体 */ }
  }
  return items.length;
}

async function runOnce() {
  if (running) return;
  running = true;
  const result = {};
  try {
    for (const src of SOURCES) {
      try {
        const n = await fetchOne(src);
        result[src.key] = n;
        console.log('[news] ' + src.key + ': +' + n);
      } catch (e) {
        lastError = src.key + ': ' + e.message;
        console.error('[news] ' + src.key + ' failed:', e.message);
      }
    }
    // 控制总量
    await pool.query(
      `DELETE FROM news WHERE id IN (SELECT id FROM news ORDER BY id DESC LIMIT -1 OFFSET ?)`, [MAX_KEEP]
    );
    lastRunAt = Date.now();
  } catch (e) {
    lastError = 'global: ' + e.message;
    console.error('[news] global error:', e.message);
  }
  running = false;
}

function startScheduler() {
  // 启动后 5 秒先抓一次，之后每 30 分钟
  setTimeout(runOnce, 5000);
  setInterval(runOnce, INTERVAL_MS);
}

// ---------- API ----------
// GET /api/news?page=1&size=12&source=gcores&q=xx
router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(+req.query.page || 1, 1);
    const size = Math.min(Math.max(+req.query.size || 12, 1), 50);
    const offset = (page - 1) * size;
    const args = [];
    let where = ' WHERE 1=1';
    if (req.query.source) { where += ' AND source = ?'; args.push(String(req.query.source)); }
    if (req.query.q) { where += ' AND (title LIKE ? OR summary LIKE ?)'; const like = '%' + String(req.query.q).trim() + '%'; args.push(like, like); }
    const [rows] = await pool.query(
      `SELECT id, source, title, summary, link, cover, published_at, created_at FROM news` + where +
      ` ORDER BY datetime(published_at) DESC, id DESC LIMIT ? OFFSET ?`,
      [...args, size, offset]
    );
    const [cnt] = await pool.query('SELECT COUNT(*) AS total FROM news' + where, args);
    // 列表 60s 内浏览器/CDN 直接复用，降低小机查询压力
    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({ data: rows, total: cnt[0].total, page, size });
  } catch (e) { next(e); }
});

// GET /api/news/sources - 来源列表 + 抓取状态
router.get('/sources', (req, res) => {
  res.json({
    sources: SOURCES.map(s => ({ key: s.key, name: s.name, lang: s.lang, emoji: s.emoji, desc: s.desc })),
    lastRunAt, lastError
  });
});

// POST /api/news/refresh - 手动触发一次抓取（仅站长本人，登录态校验；管理令牌已移除）
router.post('/refresh', requireOwner, async (req, res, next) => {
  try {
    await runOnce();
    res.json({ ok: true, lastRunAt });
  } catch (e) { next(e); }
});

// 初始化表
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT DEFAULT '',
      link TEXT UNIQUE NOT NULL,
      cover TEXT DEFAULT '',
      published_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_news_source ON news(source)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_news_pub ON news(published_at)`);
    console.log('[news] table ready');
  } catch (e) {
    console.error('[news] init failed:', e.message);
  }
})();

function getStatus() {
  return { module: 'news', running, lastRunAt, lastError };
}

module.exports = { router, startScheduler, runOnce, getStatus };

