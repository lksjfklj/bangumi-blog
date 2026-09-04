// bookrelease.js - 漫画/轻小说 新作发售日历（Bangumi sort=date 新登载流 · 增强数据源）
// 定位：底库仍是 Bangumi（登录/收藏/浏览不换）。本地全量书籍库是按 rank 同步的，
//       只能看到「已有排名的名作」，拿不到「最近出版 / 即将出版」的新卷与新刊；
//       Bangumi v0 的 type=1 & sort=date 流本身就是按条目登载日期/发售日维护的，
//       因此直接用「date 倒序流 + offset 游标」把近 WINDOW_BACK_DAYS ~ WINDOW_FORWARD_DAYS
//       窗口内登载的 漫画/小说 条目收进 bgm_book_release_calendar，供书籍 tab 顶部日历展示。
// 扫描带站长 Bangumi token：bgm 对匿名请求隐藏 R18/nsfw 书目条目，带 token 才能把成人漫画/小说
// 的新刊/新卷也收进日历（与全量库同步、条目详情接口的 token 兜底一致）。
// 数据流：
//   1) 每 6h 扫一次 date 流（offset 0 → 越过窗口左界即停，页面按日期单调递减，
//      遇到远未来/已过窗口的行快速跳过），幂等 upsert 到 bgm_book_release_calendar；
//   2) 与本地库 library_subjects 对齐标 in_library（点卡片可跳站内 /subject/:id）；
//   3) 清理早于 KEEP_DAYS 的老行，防表无限膨胀。
// 前端展示：漫画/轻小说 tab 顶部「🆕 近期出版 + 📅 即将出版」（GET /api/anime/book-release-calendar）。
const bangumi = require('./bangumi');
const { pool } = require('./db');
const rssconfig = require('./rssconfig');

const STATE_KEY = 'bgm_book_release_cal_state';

const SCAN_INTERVAL_MS = 6 * 3600 * 1000; // 每 6h 扫一次
const WINDOW_BACK_DAYS = 60;   // 保留过去 60 天（日历「近期」按 30 天展示，留足余量）
const WINDOW_FORWARD_DAYS = 45; // 未来 45 天已定档出版/发售
const KEEP_DAYS = 150;         // 清理早于该天数的老行
const PAGE_LIMIT = 50;         // 单页行数
const MAX_PAGES = 200;         // 单轮扫描页数上限（正常一轮约 80~100 页，200 兜底防失控）
const PAGE_DELAY_MS = 90;      // 页间轻微限速
const CAT_LABELS = { manga: '漫画', lightnovel: '轻小说' };

let busy = false;      // 扫描锁（单进程内串行）
let bootTimer = null;
let intervalTimer = null;
let last = null;       // 进程内最近一轮结果快照（status 接口用）

// ---------- 纯函数（便于单测） ----------
// 时区：站点面向中文用户、出版/发售日多为日本日期，统一按 UTC+8 计算“今天”
function todayStr(at) {
  const d = at ? new Date(at) : new Date();
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function addDays(dateStr, days) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// 日期展示：当年只显示「9月4日」，跨年带年份
function dateLabel(s, today) {
  const m = String(s || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return s ? String(s).replace(/-/g, '/') : '';
  const sameYear = today && String(today).slice(0, 4) === m[1];
  return (sameYear ? '' : Number(m[1]) + '年') + Number(m[2]) + '月' + Number(m[3]) + '日';
}
function parseJson(v, fallback) {
  try {
    const a = JSON.parse(v);
    return a !== undefined && a !== null ? a : fallback;
  } catch (e) { return fallback; }
}
function clampInt(v, def, min, max) {
  const n = Math.round(+(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}
// Bangumi 书籍 platform 精确值：漫画 / 小说（画集/杂志/其他平台不入日历，避免噪音）
function classifyPlatform(platform) {
  if (platform === '漫画') return 'manga';
  if (platform === '小说') return 'lightnovel';
  return null;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
// 获取站长（owner）的有效 Bangumi token：查库 + 失效自动刷新；找不到/刷新失败返回 null
async function getOwnerToken() {
  try {
    const [rows] = await pool.query(
      'SELECT id, access_token, refresh_token, token_expires_at FROM users WHERE is_owner = 1 AND access_token IS NOT NULL LIMIT 1'
    );
    if (rows && rows.length) return await bangumi.getValidToken(rows[0]);
  } catch (e) { /* ignore */ }
  return null;
}

// 抓取一页 sort=date 书籍流（429/503 指数退避重试）
async function fetchPage(offset, limit = PAGE_LIMIT, token = null) {
  const url = '/v0/subjects?type=1&sort=date&offset=' + offset + '&limit=' + limit;
  let err;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await bangumi.bgm(url, token ? { token } : {});
    } catch (e) {
      err = e;
      if (e && (e.status === 429 || e.status === 503)) {
        await delay(1200 * (attempt + 1));
        continue;
      }
      if (attempt < 3) { await delay(400 * (attempt + 1)); continue; }
    }
  }
  throw err || new Error('fetchPage failed');
}

// ---------- 数据库存取 ----------
async function upsertRow(it, category, now) {
  const rating = it.rating || {};
  const images = it.images || {};
  const metaTags = JSON.stringify(Array.isArray(it.meta_tags) ? it.meta_tags : []);
  return pool.query(
    `INSERT INTO bgm_book_release_calendar
       (subject_id, category, name, name_cn, image, date, platform, rating_score, rating_total, rank, meta_tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject_id) DO UPDATE SET
       category = excluded.category, name = excluded.name, name_cn = excluded.name_cn,
       image = excluded.image, date = excluded.date, platform = excluded.platform,
       rating_score = excluded.rating_score, rating_total = excluded.rating_total, rank = excluded.rank,
       meta_tags = excluded.meta_tags, updated_at = excluded.updated_at`,
    [String(it.id || ''), category, it.name || '', it.name_cn || '', images.common || images.medium || images.large || '',
     it.date || '', it.platform || '', rating.score || 0, rating.total || 0, rating.rank || 0, metaTags, now, now]
  );
}

function rowToItem(row, today) {
  const category = row.category;
  return {
    bgmId: row.subject_id,
    title: row.name_cn || row.name || '',
    native: row.name || '',
    romanized: '',
    category,
    categoryLabel: CAT_LABELS[category] || category,
    date: row.date || '',
    dateText: dateLabel(row.date, today),
    // 与 Galgame 卡片共用模板：langLabel 当徽标用（显示 漫画/轻小说）
    langLabel: CAT_LABELS[category] || category,
    developers: [],
    platforms: [],
    image: row.image || '',
    rating: row.rating_score || 0,
    votecount: row.rating_total || 0,
    rank: row.rank || 0,
    inLibrary: !!(row.in_library),
    inLibraryCategory: row.in_library_category || ''
  };
}

// 窗口内查询（recent DESC / upcoming ASC），带「站内本地库是否已有」标记
async function queryWindow(category, from, to, dir, limit, today) {
  const order = dir === 'ASC' ? 'ORDER BY c.date ASC, c.rating_total DESC, c.subject_id'
    : 'ORDER BY c.date DESC, c.rating_total DESC, c.subject_id';
  const where = 'c.category = ? AND c.date >= ? AND c.date <= ?';
  const params = [category, from, to];
  const libJoin =
    `LEFT JOIN (SELECT subject_id, category FROM library_subjects WHERE blocked = 0) ls
       ON ls.subject_id = c.subject_id AND ls.category = c.category`;
  const [rows] = await pool.query(
    `SELECT c.*, CASE WHEN ls.subject_id IS NULL THEN 0 ELSE 1 END AS in_library, ls.category AS in_library_category
     FROM bgm_book_release_calendar c ${libJoin} WHERE ${where} ${order} LIMIT ?`,
    [...params, limit]
  );
  const [tot] = await pool.query(
    `SELECT COUNT(*) AS n FROM bgm_book_release_calendar c WHERE ${where}`,
    params
  );
  return { items: (rows || []).map(r => rowToItem(r, today)), total: Number((tot[0] && tot[0].n) || 0) };
}

// ---------- 主扫描 ----------
// 从 offset 0 沿 date 倒序流向前走：远未来/空日期快速跳过，进入窗口后 upsert，
// 直到整页日期都已早于窗口左界（date 流有序）即停。
async function scanOnce(opts = {}) {
  if (busy) return { ok: false, reason: 'already running' };
  busy = true;
  const t0 = Date.now();
  try {
    const state = (await rssconfig.getSetting(STATE_KEY, {})) || {};
    const firstRun = !state.lastRunAt;
    const token = await getOwnerToken();
    if (!token) console.warn('[bookrelease] 未获取到站长 Bangumi token，本次扫描看不到 R18/nsfw 书目条目');
    const today = todayStr(opts.now);
    const from = addDays(today, -WINDOW_BACK_DAYS);
    const to = addDays(today, WINDOW_FORWARD_DAYS);
    const now = Date.now();
    const stats = { from, to, first: firstRun, pages: 0, fetched: 0, saved: 0, skippedFuture: 0, skippedOld: 0, truncated: false };
    let offset = 0;
    for (let p = 0; p < MAX_PAGES; p++) {
      const data = await fetchPage(offset, PAGE_LIMIT, token);
      const batch = (data && (data.data || [])) || [];
      stats.pages++;
      if (!batch.length) break;
      // 页内最小日期（跳过无日期行）；若整页都已早于窗口左界，date 流有序 -> 结束
      let minDate = null;
      let allOld = true;
      for (const it of batch) {
        const d = String(it.date || '');
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          if (minDate === null || d < minDate) minDate = d;
          if (d >= from) allOld = false;
        }
      }
      if (minDate !== null && allOld) break;
      for (const it of batch) {
        const date = String(it.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // 无具体日期不入日历
        const category = classifyPlatform(String(it.platform || ''));
        if (!category) continue;
        if (date > to) { stats.skippedFuture++; continue; }
        if (date < from) { stats.skippedOld++; continue; }
        stats.fetched++;
        await upsertRow(it, category, now);
        stats.saved++;
      }
      offset += batch.length;
      if (p + 1 < MAX_PAGES) await delay(PAGE_DELAY_MS);
    }
    stats.truncated = stats.pages >= MAX_PAGES;
    const pruned = await pruneOld(today);
    const nextState = { lastRunAt: new Date().toISOString(), lastStats: stats, pruned };
    await rssconfig.setSetting(STATE_KEY, nextState);
    last = { at: now, ok: true, stats, pruned };
    console.log('[bookrelease] 扫描完成 pages=' + stats.pages + ' saved=' + stats.saved +
      ' future=' + stats.skippedFuture + ' old=' + stats.skippedOld + ' pruned=' + pruned + ' truncated=' + stats.truncated);
    return { ok: true, stats, pruned, elapsedMs: Date.now() - t0 };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 500);
    const prev = (await rssconfig.getSetting(STATE_KEY, {})) || {};
    await rssconfig.setSetting(STATE_KEY, { ...prev, lastErrorAt: new Date().toISOString(), lastError: msg });
    last = { at: Date.now(), ok: false, error: msg };
    console.error('[bookrelease] 扫描失败:', msg);
    return { ok: false, error: msg };
  } finally {
    busy = false;
  }
}

async function pruneOld(today) {
  try {
    const keepFrom = addDays(today, -KEEP_DAYS);
    const [r] = await pool.query('DELETE FROM bgm_book_release_calendar WHERE date < ?', [keepFrom]);
    return Number((r && r[0] && r[0].affectedRows) || 0);
  } catch (e) { return 0; }
}

// ---------- 对外 API ----------
async function getCalendar({ category = 'manga', recentDays = 30, upcomingDays = 45, limit = 18 } = {}) {
  const cat = category === 'lightnovel' ? 'lightnovel' : 'manga';
  const today = todayStr();
  const recentFrom = addDays(today, -clampInt(recentDays, 30, 7, 120));
  const upcomingTo = addDays(today, clampInt(upcomingDays, 45, 7, 180));
  const lim = clampInt(limit, 18, 1, 60);
  const [recent, upcoming, state] = await Promise.all([
    queryWindow(cat, recentFrom, today, 'DESC', lim, today),
    queryWindow(cat, addDays(today, 1), upcomingTo, 'ASC', lim, today),
    rssconfig.getSetting(STATE_KEY, {})
  ]);
  return {
    source: 'bangumi',
    category: cat,
    recent: recent.items,
    recentTotal: recent.total,
    upcoming: upcoming.items,
    upcomingTotal: upcoming.total,
    stats: { lastRunAt: state.lastRunAt || null, lastError: state.lastError || null }
  };
}

async function getStatus() {
  const state = (await rssconfig.getSetting(STATE_KEY, {})) || {};
  const summary = { total: 0, manga: 0, lightnovel: 0, recent30: 0, upcoming: 0, inLibrary: 0 };
  try {
    const today = todayStr();
    const [a] = await pool.query('SELECT COUNT(*) AS n, SUM(category = ?) AS manga, SUM(category = ?) AS ln FROM bgm_book_release_calendar', ['manga', 'lightnovel']);
    summary.total = Number((a[0] && a[0].n) || 0);
    summary.manga = Number((a[0] && a[0].manga) || 0);
    summary.lightnovel = Number((a[0] && a[0].ln) || 0);
    const [b] = await pool.query('SELECT COUNT(*) AS n FROM bgm_book_release_calendar WHERE date >= ? AND date <= ?', [addDays(today, -30), today]);
    summary.recent30 = Number((b[0] && b[0].n) || 0);
    const [c] = await pool.query('SELECT COUNT(*) AS n FROM bgm_book_release_calendar WHERE date > ?', [today]);
    summary.upcoming = Number((c[0] && c[0].n) || 0);
    const [d] = await pool.query(
      `SELECT COUNT(*) AS n FROM bgm_book_release_calendar c
       INNER JOIN (SELECT subject_id, category FROM library_subjects WHERE blocked = 0) ls
         ON ls.subject_id = c.subject_id AND ls.category = c.category`
    );
    summary.inLibrary = Number((d[0] && d[0].n) || 0);
  } catch (err) { /* 状态汇总失败不阻塞 */ }
  return {
    module: 'bookrelease',
    busy,
    lastRunAt: state.lastRunAt || null,
    lastError: state.lastError || null,
    lastStats: state.lastStats || null,
    summary,
    inMemory: last
  };
}

function startScheduler() {
  if (intervalTimer) return;
  // 启动 20s 后先跑一轮（错开各模块启动高峰），之后每 6h 一次
  bootTimer = setTimeout(() => { runOnce().catch(() => {}); }, 20 * 1000);
  intervalTimer = setInterval(() => { runOnce().catch(() => {}); }, SCAN_INTERVAL_MS);
}

function runOnce(opts) {
  return scanOnce(opts || {});
}

module.exports = {
  scanOnce, runOnce, startScheduler, getCalendar, getStatus,
  todayStr, addDays, dateLabel, classifyPlatform
};
