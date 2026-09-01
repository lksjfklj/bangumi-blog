// routes/watch.js - 番剧更新追踪（RSS 订阅聚合：新番更新 + 磁力/种子链接）
// P1/P2/P3 升级：
//  - 标题解析入库（番名/话数/字幕组/画质），按番聚合展示
//  - bgm_subject_id 匹配（本地收藏优先 + Bangumi 搜索缓存），与「我的追番」联动
//  - RSS 源与关键词过滤后台可配置（settings 表）
//  - 抓取失败 Server酱/Telegram/Webhook 告警
//  - MAX_KEEP 提升到 20000，保留历史更多
// 死种检测不做：1 核小机轮询 tracker 负担太重，磁力客户端会自动跳过死种。
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetch, ProxyAgent } = require('undici');
const { pool } = require('../db');
const config = require('../config');
const { requireOwner } = require('../auth');
const { bgm, cached } = require('../bangumi');
const { shrinkCover } = require('../imgutil');
const { getSetting, setSetting, mergeSources } = require('../rssconfig');
const { parseTitle, norm, stripSeason, snorm } = require('../title');
const { notify } = require('../notify');
const router = express.Router();

let dispatcher = null;
if (config.watch.proxy) dispatcher = new ProxyAgent(config.watch.proxy);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------- 数据源（默认；可在后台 /watch 配置页覆盖/增删） ----------
const DEFAULT_SOURCES = [
  { key: 'mikan', name: '蜜柑计划 Mikan', lang: 'zh', emoji: '🍊', url: 'https://mikanani.me/RSS/Classic',
    desc: '日本动画字幕资源聚合，新番更新快', categoryInclude: null,
    magnetFrom: 'infohash', torrentFrom: 'enclosure', sizeFrom: 'enclosure' },
  { key: 'dmhy', name: '动漫花园 DMHY', lang: 'zh', emoji: '🌸', url: 'https://share.dmhy.org/topics/rss/rss.xml',
    desc: '老牌动漫资源站（仅收录动画分类）', categoryInclude: ['動畫', '动画', '動画', 'Anime'],
    magnetFrom: 'enclosure', torrentFrom: null, sizeFrom: null, coverFrom: 'description' },
  { key: 'kisssub', name: '爱恋字幕社 Kisssub', lang: 'zh', emoji: '💞', url: 'https://kisssub.org/rss.xml',
    desc: '爱恋字幕社官网（喵萌奶茶屋等合作字幕组，仅收录动画分类）', categoryInclude: ['动画'],
    magnetFrom: 'infohash', torrentFrom: null, sizeFrom: null, coverFrom: 'description' },
  { key: 'acgnx', name: 'ACGnx 末日動漫', lang: 'zh', emoji: '🌀', url: 'https://share.acgnx.se/rss.xml',
    desc: 'Project AcgnX Torrent Asia（聚合各字幕组发布，enclosure 直接是磁力）', categoryInclude: ['動畫', '动画', 'Anime'],
    magnetFrom: 'enclosure', torrentFrom: null, sizeFrom: null, coverFrom: null },
  { key: 'nyaa', name: 'Nyaa 中字动画', lang: 'zh', emoji: '🐱', url: 'https://nyaa.si/?page=rss&c=1_2',
    desc: '全球最大动漫资源站（c=1_2 非英语字幕，含各中文字幕组；过滤其他语种发布）', categoryInclude: null,
    magnetFrom: 'infohash', hashFrom: 'nyaa:infoHash', torrentFrom: 'link', sizeFrom: 'nyaa:size', coverFrom: null,
    excludeKeywords: ['vostfr', 'subfrench', 'french', 'multi', 'spanish', 'español', 'latino', 'portuguese', 'portugues', 'german', 'deutsch', 'italian', 'arabic', 'russian', 'thai', 'indonesian', 'vietnamese', 'subsplease', 'erai-raws'] },
  { key: 'airota', name: '千夏字幕组 Airota', lang: 'zh', emoji: '🌼', url: 'https://www.airota.moe/rss.xml',
    desc: '千夏字幕组官网 RSS（老牌字幕组）', categoryInclude: ['动画'],
    magnetFrom: 'auto', torrentFrom: 'enclosure', sizeFrom: null, enabled: false }, // 站点暂不可达，默认停用（后台可启用）
  { key: 'kamigami', name: '诸神字幕组 Kamigami', lang: 'zh', emoji: '🌙', url: 'https://www.kamigami.org/rss.xml',
    desc: '诸神字幕组官网 RSS（双语字幕老牌组）', categoryInclude: ['动画'],
    magnetFrom: 'auto', torrentFrom: 'enclosure', sizeFrom: null, enabled: false } // 站点暂不可达，默认停用（后台可启用）
];

// 全局排除：明显非正片视频的资源。注意不要误伤视频发布里常见的技术词（FLAC/无损 是音轨编码，1080p/HEVC 是画质）。
const DEFAULT_EXCLUDE_KEYWORDS = [
  '漫画', '单行本', '画集', '图集', '图包', '壁纸', '扫描', '写真', '设定集', '杂志',
  '小说', '轻小说', 'ost', 'original soundtrack', '主题曲', '片头曲', '片尾曲', '角色歌',
  '广播剧', 'drama cd', '音声', 'galgame'
];

const MAX_KEEP = 20000;            // 数据库最多保留条数（按入库顺序淘汰最旧）
const MAX_ITEMS_PER_SOURCE = 80;   // 单源每次最多处理条目数（1核小机限流）
const MAX_SCRAPE_PER_RUN = 10;     // 单源每次最多补抓/本地化的封面数
const MAX_BGM_MATCH_PER_RUN = 20;  // 每轮最多调 Bangumi 搜索匹配的番数（限速保护）
const FETCH_TIMEOUT = 15000;       // 单源抓取超时
const INTERVAL_MS = 30 * 60 * 1000; // 30 分钟一次（与资讯模块一致，负载很低）
const newsImgDir = path.join(__dirname, '..', '..', 'news-img');

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tr.bangumi.moe:6969/announce',
  'udp://tracker1.itzmx.com:8080/announce',
  'http://open.acgtracker.com:1096/announce'
];

let running = false;
let lastRunAt = 0;
let lastError = '';
let lastSourceResults = {};
const lastNotified = {};

function getStatus() {
  return {
    module: 'watch', running, lastRunAt, lastError, lastSourceResults,
    intervalMs: INTERVAL_MS, maxKeep: MAX_KEEP, notify: require('../notify').describe()
  };
}

// ---------- 工具 ----------
function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch (e) { return ''; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return ''; } })
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&middot;/g, '·');
}

function stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<!\[CDATA\[|\]\]>/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractFirstImg(s) {
  if (!s) return '';
  const m = String(s).match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function xmlField(xml, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function xmlAttr(xml, tag, attr) {
  const esc = String(attr).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = xml.match(new RegExp('<' + tag + '[^>]*\\b' + esc + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i'));
  return m ? (m[2] != null ? m[2] : m[3] || '') : '';
}

// 关键词匹配：拉丁词整词匹配（避免 ost 误伤 host），中文直接包含
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

function parseDateAny(d) {
  const iso = parseRfc822(d);
  if (iso) return iso;
  const t = Date.parse(String(d || ''));
  return isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
}

function btihOf(s) {
  const m = String(s || '').match(/btih:([0-9a-fA-F]{40})/i);
  if (m) return m[1].toLowerCase();
  const m2 = String(s || '').match(/([0-9a-f]{40})/i);
  return m2 ? m2[1].toLowerCase() : '';
}

function normEp(n) {
  const v = +n;
  return isFinite(v) ? String(v) : String(n);
}

// 从标题里提取话数显示（全角数字转半角）
function episodeOf(title) {
  const t = String(title || '').replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  let m = t.match(/第\s*(\d+(?:\.\d+)?)\s*(?:话|話|集)/);
  if (m) return '第' + normEp(m[1]) + '话';
  m = t.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
  if (m) return 'S' + normEp(m[1]) + 'E' + normEp(m[2]);
  m = t.match(/[\[\(（]\s*(\d{1,4})(?:v\d+)?\s*[\]\)）]/);
  if (m) return '第' + normEp(m[1]) + '话';
  m = t.match(/(^|[^\d])([-–—])\s*(\d{1,3})(?:v\d+)?\s*(?:[\[\(（]|$)/);
  if (m) return '第' + normEp(m[3]) + '话';
  m = t.match(/(^|[^\d\-–—])\s*(\d{1,3})(?:v\d+)?\s*[\[\(（]/);
  if (m) return '第' + normEp(m[2]) + '话';
  m = t.match(/全\s*(\d+)\s*(?:话|話|集)/);
  if (m) return '全' + normEp(m[1]) + '话';
  if (/剧场版|劇場版|Movie|映画|电影版|OVA|OAD|ONA|Special|SP|特别篇/.test(t)) return '特别篇';
  return '';
}

function formatSize(bytes) {
  const n = +bytes;
  if (!n || isNaN(n) || n <= 0) return '';
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1).replace(/\.0$/, '') + ' GB';
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1).replace(/\.0$/, '') + ' MB';
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1).replace(/\.0$/, '') + ' KB';
  return n + ' B';
}

function normalizeSizeText(t) {
  const m = String(t || '').trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i);
  if (!m) return '';
  const v = +m[1];
  const u = m[2].toLowerCase();
  const map = { b: 1, kb: 1 << 10, mb: 1 << 20, gb: 1 << 30, tb: 1 << 40, kib: 1 << 10, mib: 1 << 20, gib: 1 << 30, tib: 1 << 40 };
  return formatSize(v * (map[u] || 1));
}

function sizeToBytes(t) {
  const m = String(t || '').trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i);
  if (!m) return 0;
  const v = +m[1];
  const u = m[2].toLowerCase();
  const map = { b: 1, kb: 1 << 10, mb: 1 << 20, gb: 1 << 30, tb: 1 << 40, kib: 1 << 10, mib: 1 << 20, gib: 1 << 30, tib: 1 << 40 };
  return Math.round(v * (map[u] || 1));
}

// 从 Mikan episode 页 URL 提取 infohash 构造磁力
function magnetFromInfohash(hash, title) {
  if (!hash) return '';
  const dn = encodeURIComponent(String(title || '').slice(0, 200));
  const tr = TRACKERS.map(t => '&tr=' + encodeURIComponent(t)).join('');
  return 'magnet:?xt=urn:btih:' + hash + '&dn=' + dn + tr;
}

// 封面图本地缓存（复用 /api/newsimg 静态服务；按 URL md5 命名天然去重）
async function localizeCover(url) {
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
    const res = await fetchWith(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': UA } });
    if (!res.ok) return url;
    let buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return url;
    // 封面统一缩到 640px（列表卡片 96-128px，2x 屏足够），省流量且 1 核小机缓存更小
    const shrunk = await shrinkCover(buf, ext);
    buf = shrunk.buf; ext = shrunk.ext;
    const outFile = path.join(newsImgDir, key + ext);
    fs.writeFileSync(outFile, buf);
    return '/api/newsimg/' + key + ext;
  } catch (e) { return url; }
}

// ---------- 配置（settings 表可覆盖） ----------
let SOURCES_CACHE = DEFAULT_SOURCES;
let EXCLUDE_KEYWORDS = DEFAULT_EXCLUDE_KEYWORDS;
async function reloadConfig() {
  try {
    const stored = await getSetting('watch_sources', null);
    SOURCES_CACHE = mergeSources(DEFAULT_SOURCES, stored);
    const kw = await getSetting('watch_exclude_keywords', null);
    EXCLUDE_KEYWORDS = Array.isArray(kw) && kw.length ? kw : DEFAULT_EXCLUDE_KEYWORDS;
  } catch (e) { /* settings 表不可用时回退默认 */ }
}

// fetch 封装：未配置代理时不传 dispatcher（undici 不允许 null dispatcher）
async function fetchWith(srcOrUrl, opts = {}) {
  if (dispatcher) opts.dispatcher = dispatcher;
  return fetch(srcOrUrl, opts);
}

// ---------- 抓取与入库 ----------
async function fetchOne(src) {
  const res = await fetchWith(src.url, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const xml = await res.text();
  const items = [];
  const re = /<item[\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (items.length >= MAX_ITEMS_PER_SOURCE) break;
    const block = m[0];
    const title = decodeEntities(stripHtml(xmlField(block, 'title'))).replace(/\s+/g, ' ').trim();
    const link = (xmlField(block, 'link') || xmlField(block, 'guid')).trim();
    if (!title || !link) continue;
    const category = decodeEntities(stripHtml(xmlField(block, 'category')));
    const pubRaw = xmlField(block, 'pubDate');
    const enclosureUrl = decodeEntities(xmlAttr(block, 'enclosure', 'url')).trim();
    const enclosureLen = xmlAttr(block, 'enclosure', 'length');
    const description = xmlField(block, 'description');

    if (src.categoryInclude && src.categoryInclude.length) {
      if (!category || !src.categoryInclude.some(c => category.includes(c))) continue;
    }
    const hay = title.toLowerCase();
    if (keywordMatches(hay, EXCLUDE_KEYWORDS)) continue;
    if (src.excludeKeywords && keywordMatches(hay, src.excludeKeywords)) continue;

    // 磁力解析：enclosure=直接磁力 / infohash=从 link 构造 / auto=enclosure 磁力优先否则 infohash
    let hash = src.hashFrom ? btihOf(xmlField(block, src.hashFrom)) : '';
    let magnet = '', torrentUrl = '';
    const isMagnet = /^magnet:/.test(enclosureUrl);
    if (src.magnetFrom === 'enclosure' || (src.magnetFrom === 'auto' && isMagnet)) {
      magnet = enclosureUrl;
      hash = btihOf(magnet) || crypto.createHash('md5').update(link).digest('hex');
    } else {
      hash = hash || btihOf(link);
      magnet = magnetFromInfohash(hash, title);
      torrentUrl = src.magnetFrom === 'auto' && !isMagnet ? enclosureUrl : enclosureUrl;
      if (src.torrentFrom === 'link') torrentUrl = link;
    }
    if (!magnet) continue;

    // 文件大小：enclosure length / 自定义标签 / description 里提取
    let fileSize = '';
    if (src.sizeFrom === 'enclosure') fileSize = formatSize(enclosureLen);
    else if (src.sizeFrom) fileSize = normalizeSizeText(xmlField(block, src.sizeFrom));
    if (!fileSize) {
      const desc = decodeEntities(stripHtml(description));
      let fm = desc.match(/\[([\d.]+\s*(?:GB|MB|KB))\]/i);
      if (fm) fileSize = fm[1].replace(/\s+/g, '');
      else {
        fm = desc.match(/\|\s*([\d.]+\s*(?:GB|MB|KB))\s*\|/i);
        if (fm) fileSize = fm[1].replace(/\s+/g, '');
      }
    }

    // 标题解析：番名 / 话数 / 字幕组 / 画质
    const parsed = parseTitle(title);
    const seriesTitle = parsed.seriesTitle || title;
    const seriesKey = norm(stripSeason(seriesTitle)) || crypto.createHash('md5').update(seriesTitle).digest('hex').slice(0, 12);

    items.push({
      source: src.key, title,
      episode: parsed.episode || episodeOf(title),
      hash, link, magnet, torrent_url: torrentUrl,
      cover: src.coverFrom === 'description' ? extractFirstImg(description) : '',
      file_size: fileSize, file_bytes: sizeToBytes(fileSize),
      published_at: parseDateAny(pubRaw), category,
      series_title: seriesTitle, series_key: seriesKey,
      sub_group: parsed.subGroup || '', quality: parsed.quality || ''
    });
  }
  return items;
}

// ---------- Bangumi subject 匹配（本地收藏优先 + 搜索缓存） ----------
let bgmSeriesCache = null;
// 季号感知：parseTitle 会把「第三季/S3/3期/3rd Season」剥掉，这里从原始标题提取季号，
// 匹配时拼回规范季名，避免 S3 资源被匹配到 S1 条目（S1/S3 的 series_key 相同，容易串季）。
const SEASON_PHRASE_RE = /第\s*[0-9０-９一二三四五六七八九十]+\s*[季期]|\b[0-9０-９]{1,2}\s*[季期]\b|\b[0-9]{1,2}\s*(?:st|nd|rd|th)?\s*season\b|\bseason\s*[0-9]{1,2}\b|\bS\s*[0-9]{1,2}\b|\b[ⅠⅡⅢⅣⅤⅥ]+\b/gi;
function seasonPhrase(raw) {
  const m = String(raw || '').match(SEASON_PHRASE_RE);
  return m ? m.join(' ').trim() : '';
}
const CN2N = {一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
function seasonNum(s) {
  const t = String(s || '').toLowerCase();
  let m = t.match(/第\s*([0-9０-９一二三四五六七八九十]+)\s*[季期]/);
  if (m) {
    const v = m[1];
    if (/^[0-9]+$/.test(v)) return +v;
    let n = 0;
    if (v.includes('十')) { const a = v.split('十'); n = (a[0] && CN2N[a[0]] || 1) * 10 + (CN2N[a[1]] || 0); }
    else n = CN2N[v] || 0;
    if (n) return n;
  }
  m = t.match(/(?:season|s)\s*[. ]?([0-9]{1,2})\b/);
  if (m) return +m[1];
  m = t.match(/\b([0-9]{1,2})\s*(?:st|nd|rd|th)?\s*season\b/);
  if (m) return +m[1];
  m = t.match(/[ⅠⅡⅢⅣⅤⅥ]/);
  if (m) return 'ⅠⅡⅢⅣⅤⅥ'.indexOf(m[0]) + 1;
  m = t.match(/([0-9０-９]{1,2})\s*[季期]/);
  if (m) return +m[1];
  return 0;
}
// legacy 搜索接口对 ~ / 等字符会 404，且中英混杂容易空结果，搜索词需清洗
function cleanSearchKw(s) {
  return String(s || '')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function cjkOnlyName(s) {
  return String(s || '')
    .replace(/\d{4}\s*年\s*\d{1,2}\s*月\s*番?/g, '')
    .replace(/[^\u4e00-\u9fff]/g, '')
    .replace(/^[年月日番期]+|[年月日番期]+$/g, '');
}
async function matchBgm(seriesTitle, seriesKey, rawTitle) {
  if (!seriesKey || seriesKey.length < 2) return 0;
  const sk = snorm(seriesKey);
  // 严格包含：短侧 >= 5 字且占比 >= 60%，避免「异世界」「再见」这类短词误配
  const strictInc = (x, y) => {
    if (x.length < 5 || y.length < 5) return false;
    const sh = Math.min(x.length, y.length), lo = Math.max(x.length, y.length);
    return sh >= lo * 0.6 && (x.includes(y) || y.includes(x));
  };
  const sp = seasonPhrase(rawTitle || '');
  const kwSeason = sp ? seasonNum(sp) : 0;
  // 候选搜索词：季号规范版（若有）> 清洗后的 seriesTitle > 纯中文串
  const kws = [];
  const pushKw = x => { x = cleanSearchKw(x).slice(0, 60); if (x && !kws.includes(x)) kws.push(x); };
  if (sp && kwSeason) {
    const cn = ['零','一','二','三','四','五','六','七','八','九'][kwSeason] || String(kwSeason);
    pushKw(seriesTitle + ' 第' + cn + '季');
  }
  pushKw(seriesTitle);
  const cjk = cjkOnlyName(seriesTitle);
  if (cjk.length >= 2) pushKw(cjk);
  // 本地收藏缓存：仅在没有季号歧义时使用（S1/S3 同名不同季会串）
  if (!sp) {
    try {
      if (!bgmSeriesCache) {
        bgmSeriesCache = new Map();
        const [cols] = await pool.query("SELECT DISTINCT subject_id, name, name_cn FROM collections WHERE (name IS NOT NULL AND name != '') OR (name_cn IS NOT NULL AND name_cn != '')");
        for (const c of cols) {
          for (const n of [c.name, c.name_cn]) {
            if (!n) continue;
            const nn = norm(n), sn = snorm(n);
            if (nn && !bgmSeriesCache.has(nn)) bgmSeriesCache.set(nn, c.subject_id);
            if (sn && !bgmSeriesCache.has(sn)) bgmSeriesCache.set(sn, c.subject_id);
          }
        }
      }
      for (const kw of kws) {
        const k1 = norm(kw), k2 = snorm(kw);
        if (bgmSeriesCache.has(k1)) return bgmSeriesCache.get(k1);
        if (bgmSeriesCache.has(k2)) return bgmSeriesCache.get(k2);
      }
      if (bgmSeriesCache.has(seriesKey)) return bgmSeriesCache.get(seriesKey);
      if (bgmSeriesCache.has(sk)) return bgmSeriesCache.get(sk);
      for (const [nn, sid] of bgmSeriesCache) {
        if (strictInc(nn, seriesKey) || strictInc(nn, sk)) return sid;
      }
    } catch (e) { /* 收藏表读取失败 -> 走 bgm 搜索 */ }
  }
  if (!kws.length) return 0;
  for (const kw of kws) {
    try {
      // legacy 搜索接口（/v0/search/subjects 当前 404）；带季号时用季号版本做缓存键
      const data = await cached('bgm:search:anime:' + norm(kw), 30 * 24 * 3600 * 1000, () =>
        bgm('/search/subject/' + encodeURIComponent(kw) + '?type=2')
      );
      const list = (data && Array.isArray(data.list)) ? data.list : ((data && Array.isArray(data.data)) ? data.data : []);
      if (!list.length) continue;
      const k1 = norm(kw), k2 = snorm(kw);
      // 1) 精确名匹配
      for (const it of list) {
        const a1 = norm(it.name), a2 = norm(it.name_cn || '');
        const b1 = snorm(it.name), b2 = snorm(it.name_cn || '');
        if (a1 === k1 || a2 === k1 || b1 === k2 || b2 === k2) return it.id;
      }
      // 2) 严格包含（带季号时优先同季，无季号结果兜底）
      for (const it of list) {
        const a = norm(it.name), b = norm(it.name_cn || '');
        const c = snorm(it.name), d = snorm(it.name_cn || '');
        const itemSeason = seasonNum((it.name_cn || '') + ' ' + (it.name || ''));
        for (const z of [a, b, c, d]) {
          if (strictInc(z, k1) || strictInc(z, k2)) {
            if (!kwSeason) return it.id;
            if (itemSeason === 0 || itemSeason === kwSeason) return it.id;
          }
        }
      }
      // 3) 中文重叠兜底（候选 >= 5 汉字、重合 >= 4、重合率 >= 80%，季号一致性加权）
      const cjk = String(kw).replace(/[^\u4e00-\u9fff]/g, '');
      if (cjk.length >= 5) {
        const want = new Set(cjk);
        let best = 0, bestSid = 0;
        for (let i = 0; i < Math.min(list.length, 8); i++) {
          const it = list[i];
          const n = snorm(it.name_cn || it.name || '');
          const got = new Set(n.replace(/[^\u4e00-\u9fff]/g, ''));
          let common = 0;
          for (const ch of want) if (got.has(ch)) common++;
          if (common >= 4 && common / want.size >= 0.8) {
            let score = common;
            if (kwSeason) {
              const is = seasonNum((it.name_cn || '') + ' ' + (it.name || ''));
              if (is === kwSeason) score += 3;
              else if (is !== 0) score -= 3;
            }
            if (score > best) { best = score; bestSid = it.id; }
          }
        }
        if (bestSid) return bestSid;
      }
    } catch (e) { /* 限速/网络失败 -> 试下一个候选词 */ }
  }
  return 0;
}

async function runOnce() {
  if (running) return;
  running = true;
  bgmSeriesCache = null; // 每轮重建（收藏可能变化）
  await reloadConfig();
  const sources = SOURCES_CACHE;
  try {
    for (const src of sources) {
      if (src.enabled === false) continue; // 后台停用的源不抓取
      let scraped = 0;
      const itemResult = { ok: false, added: 0, error: '' };
      try {
        const items = await fetchOne(src);
        let added = 0;
        const pendingBgm = [];
        const seenSeries = new Set();
        for (const it of items) {
          try {
            const [exist] = await pool.query('SELECT 1 FROM anime_episodes WHERE source = ? AND hash = ?', [it.source, it.hash]);
            if (exist.length) continue;
            if (it.cover && scraped < MAX_SCRAPE_PER_RUN) { scraped++; it.cover = await localizeCover(it.cover); }
            await pool.query(
              `INSERT OR IGNORE INTO anime_episodes
                 (source, title, episode, hash, link, magnet, torrent_url, cover, file_size, file_bytes, published_at,
                  series_title, series_key, sub_group, quality)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [it.source, it.title, it.episode, it.hash, it.link, it.magnet, it.torrent_url, it.cover,
               it.file_size, it.file_bytes, it.published_at, it.series_title, it.series_key, it.sub_group, it.quality]
            );
            if (!seenSeries.has(it.series_key)) {
              seenSeries.add(it.series_key);
              pendingBgm.push({ series_key: it.series_key, series_title: it.series_title, title: it.title });
            }
            added++;
          } catch (e) { /* 单条失败不影响整体 */ }
        }
        // 新番的 Bangumi 匹配（只对新行、每轮限量，保护 1 核小机和 bgm 限速）
        for (let i = 0; i < Math.min(pendingBgm.length, MAX_BGM_MATCH_PER_RUN); i++) {
          try {
            const p = pendingBgm[i];
            let sid = 0;
            try {
              // 同 series_key 已有匹配结果直接继承，避免 S1/S3 同 key 串季或反复调搜索
              const [ex] = await pool.query('SELECT bgm_subject_id FROM anime_episodes WHERE series_key = ? AND bgm_subject_id IS NOT NULL LIMIT 1', [p.series_key]);
              if (ex.length) sid = ex[0].bgm_subject_id;
            } catch (e) { /* 忽略，走搜索 */ }
            if (!sid) sid = await matchBgm(p.series_title, p.series_key, p.title);
            if (sid) {
              await pool.query('UPDATE anime_episodes SET bgm_subject_id = ? WHERE series_key = ? AND bgm_subject_id IS NULL', [sid, p.series_key]);
            }
          } catch (e) { /* 单个匹配失败忽略 */ }
        }
        itemResult.ok = true;
        itemResult.added = added;
        console.log('[watch] ' + src.key + ': +' + added);
      } catch (e) {
        itemResult.error = e.message;
        lastError = src.key + ': ' + e.message;
        console.error('[watch] ' + src.key + ' failed:', e.message);
        // 告警：同源同错误 30 分钟内只推一次
        const now = Date.now();
        if (!lastNotified[src.key] || now - lastNotified[src.key] > 30 * 60 * 1000) {
          lastNotified[src.key] = now;
          notify('[watch] RSS 抓取失败：' + (src.name || src.key), e.message + '\n源：' + (src.url || ''));
        }
      }
      lastSourceResults[src.key] = { ...itemResult, at: Date.now() };
    }
    // 控制总量（按入库顺序淘汰最旧）
    await pool.query(
      'DELETE FROM anime_episodes WHERE id IN (SELECT id FROM anime_episodes ORDER BY id DESC LIMIT -1 OFFSET ?)', [MAX_KEEP]
    );
    lastRunAt = Date.now();
  } catch (e) {
    lastError = 'global: ' + e.message;
    console.error('[watch] global error:', e.message);
  }
  running = false;
}

function startScheduler() {
  // 启动后 5 秒先抓一次，之后每 30 分钟
  setTimeout(() => { runOnce().catch(() => {}); }, 5000);
  setInterval(() => { runOnce().catch(() => {}); }, INTERVAL_MS);
}

// ---------- API ----------
function buildFilter(req, user) {
  const args = [];
  let where = ' WHERE 1=1';
  if (req.query.source) { where += ' AND source = ?'; args.push(String(req.query.source)); }
  const kw = String(req.query.q || '').trim().replace(/[%_]/g, '').slice(0, 100);
  if (kw) { where += ' AND (title LIKE ? OR series_title LIKE ?)'; args.push('%' + kw + '%', '%' + kw + '%'); }
  if (req.query.sub_group) { where += ' AND sub_group = ?'; args.push(String(req.query.sub_group).slice(0, 40)); }
  if (req.query.quality) { where += ' AND quality = ?'; args.push(String(req.query.quality).slice(0, 20)); }
  const days = Math.min(Math.max(+req.query.days || 0, 1), 3650);
  if (req.query.days) { where += " AND published_at >= datetime('now', ?)"; args.push('-' + days + ' days'); }
  if (req.query.subject_id) { where += ' AND bgm_subject_id = ?'; args.push(+req.query.subject_id); }
  if (req.query.my === '1') {
    if (!user) return null;
    where += ' AND bgm_subject_id IN (SELECT subject_id FROM collections WHERE user_id = ? AND status IN (1,3))';
    args.push(user.id);
  }
  return { where, args };
}

// 分组列表：按番聚合（P2 核心）
// GET /api/watch/groups?page=1&size=12&source=&q=&sub_group=&quality=&days=&my=1&per_group=3
router.get('/groups', async (req, res, next) => {
  try {
    const page = Math.max(+req.query.page || 1, 1);
    const size = Math.min(Math.max(+req.query.size || 12, 1), 50);
    const perGroup = Math.min(Math.max(+req.query.per_group || 3, 1), 10);
    const offset = (page - 1) * size;
    const f = buildFilter(req, req.user);
    if (!f) return res.status(401).json({ error: '请先登录后使用"只看我追的"', status: 401 });
    const [rows] = await pool.query(
      `SELECT series_key, MAX(published_at) AS last_pub, COUNT(*) AS cnt, MAX(bgm_subject_id) AS bgm_id
       FROM anime_episodes${f.where}
       GROUP BY series_key
       ORDER BY last_pub DESC, MAX(id) DESC
       LIMIT ? OFFSET ?`,
      [...f.args, size, offset]
    );
    const [cnt] = await pool.query('SELECT COUNT(DISTINCT series_key) AS total FROM anime_episodes' + f.where, f.args);
    const keys = rows.map(r => r.series_key);
    const versions = [];
    if (keys.length) {
      const placeholders = keys.map(() => '?').join(',');
      const [vs] = await pool.query(
        `SELECT id, source, title, series_title, series_key, episode, sub_group, quality, link, magnet, torrent_url,
                cover, file_size, file_bytes, published_at, created_at, bgm_subject_id
         FROM anime_episodes WHERE series_key IN (${placeholders}) ORDER BY published_at DESC, id DESC`,
        keys
      );
      versions.push(...vs);
    }
    const data = [];
    for (const r of rows) {
      const vs = versions.filter(v => v.series_key === r.series_key).slice(0, perGroup);
      const subGroups = [...new Set(vs.map(v => v.sub_group).filter(Boolean))].slice(0, 6);
      const qualities = [...new Set(vs.map(v => v.quality).filter(Boolean))].slice(0, 6);
      data.push({
        series_key: r.series_key,
        series_title: vs[0] ? vs[0].series_title : r.series_key,
        latest_episode: vs[0] ? vs[0].episode : '',
        latest_published_at: r.last_pub,
        count: r.cnt,
        bgm_subject_id: r.bgm_id || (vs[0] && vs[0].bgm_subject_id) || null,
        cover: (vs.find(v => v.cover) || {}).cover || '',
        sub_groups: subGroups,
        qualities,
        sources: [...new Set(vs.map(v => v.source))].slice(0, 6),
        versions: vs.map(v => ({
          id: v.id, source: v.source, title: v.title, episode: v.episode, sub_group: v.sub_group,
          quality: v.quality, link: v.link, magnet: v.magnet, torrent_url: v.torrent_url,
          cover: v.cover, file_size: v.file_size, published_at: v.published_at, created_at: v.created_at
        }))
      });
    }
    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({ data, total: cnt[0].total, page, size });
  } catch (e) { next(e); }
});

// 某一番的全部版本（展开用）
router.get('/group-versions', async (req, res, next) => {
  try {
    const key = String(req.query.series_key || '').slice(0, 120);
    if (!key) return res.json({ data: [], total: 0 });
    const [vs] = await pool.query(
      `SELECT id, source, title, series_title, episode, sub_group, quality, link, magnet, torrent_url,
              cover, file_size, published_at, created_at
       FROM anime_episodes WHERE series_key = ? ORDER BY published_at DESC, id DESC LIMIT 200`,
      [key]
    );
    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({ data: vs, total: vs.length });
  } catch (e) { next(e); }
});

// 平铺列表（兼容旧版 / 简单浏览）
// GET /api/watch/episodes?page=1&size=24&source=&q=&sub_group=&quality=&days=&my=1&sort=pub|size
router.get('/episodes', async (req, res, next) => {
  try {
    const page = Math.max(+req.query.page || 1, 1);
    const size = Math.min(Math.max(+req.query.size || 24, 1), 50);
    const offset = (page - 1) * size;
    const f = buildFilter(req, req.user);
    if (!f) return res.status(401).json({ error: '请先登录后使用"只看我追的"', status: 401 });
    const sortSql = req.query.sort === 'size'
      ? 'ORDER BY file_bytes DESC, published_at DESC'
      : 'ORDER BY published_at DESC, id DESC';
    const [rows] = await pool.query(
      `SELECT id, source, title, series_title, episode, sub_group, quality, link, magnet, torrent_url,
              cover, file_size, published_at, created_at, bgm_subject_id
       FROM anime_episodes${f.where} ${sortSql} LIMIT ? OFFSET ?`,
      [...f.args, size, offset]
    );
    const [cnt] = await pool.query('SELECT COUNT(*) AS total FROM anime_episodes' + f.where, f.args);
    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({ data: rows, total: cnt[0].total, page, size });
  } catch (e) { next(e); }
});

// 我的追番最新更新（P1 联动核心）
// GET /api/watch/my-updates?limit=8
router.get('/my-updates', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: '请先登录', status: 401 });
    const limit = Math.min(Math.max(+req.query.limit || 8, 1), 30);
    const [rows] = await pool.query(
      `SELECT c.subject_id, c.name, c.name_cn, c.image,
              e.series_key, e.series_title, e.episode, e.sub_group, e.quality, e.published_at, e.magnet, e.link,
              c.status
       FROM collections c
       JOIN anime_episodes e ON e.bgm_subject_id = c.subject_id
       WHERE c.user_id = ? AND c.status IN (1,3)
         AND e.published_at >= datetime('now', '-30 days')
       GROUP BY c.subject_id, e.series_key
       ORDER BY MAX(e.published_at) DESC
       LIMIT ?`,
      [req.user.id, limit]
    );
    res.set('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({ data: rows, total: rows.length });
  } catch (e) { next(e); }
});

// 筛选项（字幕组/画质/来源去重列表）
// GET /api/watch/filters
router.get('/filters', async (req, res, next) => {
  try {
    const [sg] = await pool.query("SELECT DISTINCT sub_group FROM anime_episodes WHERE sub_group != '' ORDER BY sub_group LIMIT 200");
    const [q] = await pool.query("SELECT DISTINCT quality FROM anime_episodes WHERE quality != '' ORDER BY quality LIMIT 40");
    const [src] = await pool.query('SELECT DISTINCT source FROM anime_episodes ORDER BY source');
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({
      sub_groups: sg.map(r => r.sub_group),
      qualities: q.map(r => r.quality),
      sources: src.map(r => r.source)
    });
  } catch (e) { next(e); }
});

// 来源列表 + 抓取状态 + 各源条数
router.get('/sources', async (req, res, next) => {
  try {
    await reloadConfig();
    const [rows] = await pool.query('SELECT source, COUNT(*) AS n FROM anime_episodes GROUP BY source');
    const counts = {};
    for (const r of rows) counts[r.source] = r.n;
    res.json({
      sources: SOURCES_CACHE.map(s => ({ key: s.key, name: s.name, lang: s.lang, emoji: s.emoji, desc: s.desc, count: counts[s.key] || 0 })),
      lastRunAt, lastError, lastSourceResults
    });
  } catch (e) { next(e); }
});

// 配置读取（公开：只读源列表 + 排除词）
router.get('/config', async (req, res, next) => {
  try {
    await reloadConfig();
    const kw = await getSetting('watch_exclude_keywords', null);
    res.json({
      sources: SOURCES_CACHE.map(s => ({
        key: s.key, name: s.name, lang: s.lang, emoji: s.emoji, url: s.url,
        desc: s.desc, enabled: s.enabled !== false, magnetFrom: s.magnetFrom || '',
        categoryInclude: s.categoryInclude || null
      })),
      excludeKeywords: Array.isArray(kw) ? kw : DEFAULT_EXCLUDE_KEYWORDS,
      notify: require('../notify').describe(),
      notifyEnabled: require('../notify').enabled()
    });
  } catch (e) { next(e); }
});

// 保存配置（仅站长）：源开关/自定义源 + 全局排除词
router.post('/config', requireOwner, async (req, res, next) => {
  try {
    const body = req.body || {};
    const stored = [];
    const known = new Set(DEFAULT_SOURCES.map(s => s.key));
    for (const s of Array.isArray(body.sources) ? body.sources : []) {
      if (!s || !s.key) continue;
      const item = { key: String(s.key).slice(0, 40) };
      if (s.enabled === false) item.enabled = false;
      else if (known.has(item.key)) item.enabled = true;
      if (s.url && known.has(item.key)) item.url = String(s.url).slice(0, 300);
      if (s.name) item.name = String(s.name).slice(0, 60);
      if (s.emoji) item.emoji = String(s.emoji).slice(0, 4);
      if (s.magnetFrom) item.magnetFrom = String(s.magnetFrom).slice(0, 20);
      if (Array.isArray(s.categoryInclude)) item.categoryInclude = s.categoryInclude.map(String).slice(0, 10);
      stored.push(item);
    }
    await setSetting('watch_sources', stored);
    if (Array.isArray(body.excludeKeywords)) {
      const kw = body.excludeKeywords.map(String).map(s => s.trim()).filter(Boolean).slice(0, 200);
      await setSetting('watch_exclude_keywords', kw);
    }
    await reloadConfig();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 手动触发一次抓取（仅站长）
router.post('/refresh', requireOwner, async (req, res, next) => {
  try {
    await runOnce();
    res.json({ ok: true, lastRunAt, lastSourceResults });
  } catch (e) { next(e); }
});

// 测试告警推送（仅站长）
router.post('/notify-test', requireOwner, async (req, res, next) => {
  try {
    const ok = await notify('[watch] 告警推送测试', '如果你收到了这条消息，说明 Server酱/Telegram/Webhook 通知配置正常。');
    res.json({ ok, delivered: ok, describe: require('../notify').describe() });
  } catch (e) { next(e); }
});

// ---------- 初始化表 ----------
async function ensureColumns() {
  const [cols] = await pool.query('PRAGMA table_info(anime_episodes)');
  const has = name => cols.some(c => c.name === name);
  const adds = [
    ['series_title', "series_title TEXT DEFAULT ''"],
    ['series_key', "series_key TEXT DEFAULT ''"],
    ['sub_group', "sub_group TEXT DEFAULT ''"],
    ['quality', "quality TEXT DEFAULT ''"],
    ['file_bytes', 'file_bytes INTEGER DEFAULT 0'],
    ['bgm_subject_id', 'bgm_subject_id INTEGER']
  ];
  for (const [name, ddl] of adds) {
    if (!has(name)) {
      try { await pool.query('ALTER TABLE anime_episodes ADD COLUMN ' + ddl); console.log('[watch] add column ' + name); }
      catch (e) { console.error('[watch] migrate fail ' + name + ': ' + e.message); }
    }
  }
}

// 老数据回填：解析标题填充新列（v2：一次性全量重解析，用于升级解析器后清洗旧数据）
async function backfill() {
  try {
    const done = await getSetting('watch_backfill_v2', false);
    if (done) {
      // 仅兜底：仍有 series_key 为空的极少数行（解析失败）不再重复处理
      const [rows] = await pool.query("SELECT id, title, file_size FROM anime_episodes WHERE series_key = '' ORDER BY id DESC LIMIT 2000");
      if (!rows.length) return;
      let updated = 0;
      for (const r of rows) {
        const p = parseTitle(r.title);
        const seriesTitle = p.seriesTitle || r.title;
        const seriesKey = norm(stripSeason(seriesTitle));
        if (!seriesKey) continue;
        await pool.query(
          'UPDATE anime_episodes SET series_title = ?, series_key = ?, sub_group = ?, quality = ?, episode = ?, file_bytes = ? WHERE id = ?',
          [seriesTitle, seriesKey, p.subGroup || '', p.quality || '', p.episode || '', sizeToBytes(r.file_size), r.id]
        );
        updated++;
      }
      if (updated) console.log('[watch] backfill(empty) ' + updated + ' rows');
      return;
    }
    // v2 全量重解析（一次性）：以原始 title 重新 parseTitle，重建分组与标签
    const [cnt] = await pool.query('SELECT COUNT(*) AS n FROM anime_episodes');
    const total = cnt[0].n || 0;
    if (total > 0) {
      let updated = 0, changed = 0;
      const BATCH = 500;
      let lastId = 0;
      while (true) {
        const [batch] = await pool.query(
          'SELECT id, title, file_size FROM anime_episodes WHERE id > ? ORDER BY id ASC LIMIT ?',
          [lastId, BATCH]
        );
        if (!batch.length) break;
        for (const r of batch) {
          lastId = r.id;
          const p = parseTitle(r.title);
          const seriesTitle = p.seriesTitle || r.title;
          const seriesKey = norm(stripSeason(seriesTitle));
          if (!seriesKey) continue;
          await pool.query(
            'UPDATE anime_episodes SET series_title = ?, series_key = ?, sub_group = ?, quality = ?, episode = ?, file_bytes = ? WHERE id = ?',
            [seriesTitle, seriesKey, p.subGroup || '', p.quality || '', p.episode || '', sizeToBytes(r.file_size), r.id]
          );
          updated++;
        }
        if (batch.length < BATCH) break;
      }
      console.log('[watch] backfill v2 done: ' + updated + '/' + total + ' rows re-parsed');
    }
    await setSetting('watch_backfill_v2', true);
  } catch (e) {
    console.error('[watch] backfill failed:', e.message);
  }
}

(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS anime_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      episode TEXT DEFAULT '',
      hash TEXT NOT NULL,
      link TEXT NOT NULL,
      magnet TEXT DEFAULT '',
      torrent_url TEXT DEFAULT '',
      cover TEXT DEFAULT '',
      file_size TEXT DEFAULT '',
      published_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (source, hash)
    )`);
    await ensureColumns();
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ep_pub ON anime_episodes(published_at)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ep_source ON anime_episodes(source)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ep_hash ON anime_episodes(hash)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ep_series ON anime_episodes(series_key)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ep_bgm ON anime_episodes(bgm_subject_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ep_subgroup ON anime_episodes(sub_group)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ep_quality ON anime_episodes(quality)');
    await reloadConfig();
    backfill().catch(() => {});
    console.log('[watch] table ready');
  } catch (e) {
    console.error('[watch] init failed:', e.message);
  }
})();

module.exports = { router, startScheduler, runOnce, getStatus, episodeOf, matchBgm };
