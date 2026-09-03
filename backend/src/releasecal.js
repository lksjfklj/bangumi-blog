// releasecal.js - Galgame 新作发售日历 / 新作检测（VNDB 增强数据源 · 第二阶段）
// 定位：底库仍是 Bangumi（登录/收藏/浏览不换），VNDB 只负责把「新」补上——
//       Bangumi 全量库是按 rank 同步的，拿不到「即将发售 / 刚发售的新作」，
//       而 VNDB 的 vn 表本身就是按发行日维护的。
// 数据流：
//   1) 每 6h 增量扫 VNDB「近 SCAN_BACK_DAYS 天已发售 + 未来 SCAN_FORWARD_DAYS 天已定档」窗口，
//      只收核心原语种（ja / zh-Hans / zh-Hant / ko），幂等 upsert 进 vndb_release_calendar；
//   2) 与本地库 library_source_map(source='vndb') 对齐，标记 bgm_id —— 前端可跳站内条目；
//   3) 对「近 NOTIFY_BACK_DAYS 天发售、尚未推送过」的新作，走站长告警通道发一次「新作速报」。
// 前端展示：Galgame tab 顶部「🎮 Galgame 新作 · 发售日历」（GET /api/anime/release-calendar）。
const vndb = require('./vndb');
const { pool } = require('./db');
const rssconfig = require('./rssconfig');
const notify = require('./notify');

const STATE_KEY = 'release_cal_state';

// 只收这些原语种：en 等欧美 VN 噪音大（单月几百条同人/非日式），ja + 中文才是本站 galgame 定位
const CORE_LANGS = ['ja', 'zh-Hans', 'zh-Hant', 'ko'];
const LANG_LABELS = { ja: '日语', 'zh-Hans': '中文', 'zh-Hant': '中文', ko: '韩语' };
const LANG_PH = CORE_LANGS.map(() => '?').join(',');

// VNDB vn 接口拉取字段：比搜索场景轻量（不取 aliases/alttitle，标题族只取各语言原生 + 罗马音）
const API_FIELDS = 'id, title, titles.lang, titles.title, titles.latin, released, olang, platforms, developers.name, image.url, rating, votecount, popularity, length';

const SCAN_INTERVAL_MS = 6 * 3600 * 1000; // 每 6h 扫一次（与 VNDB 匿名限速兼容：一轮约 2~6 次请求）
const FIRST_BACK_DAYS = 60;  // 首次部署回填近 60 天，让日历开箱即有近期内容
const SCAN_BACK_DAYS = 10;   // 之后每次只重扫最近 10 天（容错 VNDB 发售日被校正 / 补录）
const SCAN_FORWARD_DAYS = 45; // 未来 45 天已定档发售
const KEEP_DAYS = 150;        // 清理早于该天数的老行（日历只需近期窗口，防表无限膨胀）
const NOTIFY_BACK_DAYS = 4;   // 只对近 4 天内发售的新作推送速报
const MAX_PAGES = 40;         // 单轮扫描页数上限（每页最多 100 条）

let busy = false;      // 扫描锁（单进程内串行，避免 6h 定时与手动刷新并发）
let bootTimer = null;
let intervalTimer = null;
let last = null;       // 进程内最近一轮结果快照（status 接口用）

// ---------- 纯函数（便于单测） ----------
// 时区：站点面向中文用户、游戏发售日多为日本日期，统一按 UTC+8 计算“今天”
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
// 从 VNDB titles 数组挑展示标题：中文原生 > 日文原生 > 罗马音 > vndb.title
function pickTitle(titles, mainTitle) {
  const list = Array.isArray(titles) ? titles : [];
  let zh = '', zhHant = '', ja = '', latin = '';
  for (const t of list) {
    if (!t) continue;
    if (t.lang === 'zh-Hans' && t.title && !zh) zh = t.title;
    if (t.lang === 'zh-Hant' && t.title && !zhHant) zhHant = t.title;
    if (t.lang === 'ja' && t.title && !ja) ja = t.title;
    if (t.latin && !latin) latin = t.latin;
  }
  return {
    native: zh || zhHant || ja || '',
    latin: latin || mainTitle || '',
    display: zh || zhHant || ja || latin || mainTitle || ''
  };
}

// ---------- 数据库存取 ----------
// 与本地 Bangumi 库对齐的公共子查询：vndb id -> 库内 galgame 的 bgm subject_id
const LIB_MATCH_SQL =
  `LEFT JOIN (SELECT source_id, MIN(bgm_id) AS bgm_id FROM library_source_map
              WHERE source = 'vndb' AND status = 'ok' GROUP BY source_id) m ON m.source_id = c.vndb_id`;

async function upsertRow(vn, now) {
  const titles = JSON.stringify(vn.titles || []);
  const devs = JSON.stringify((vn.developers || []).map(d => (d && d.name) || '').filter(Boolean));
  const plats = JSON.stringify((vn.platforms || []).slice(0, 12));
  const image = (vn.image && vn.image.url) || '';
  await pool.query(
    `INSERT INTO vndb_release_calendar
       (vndb_id, title, titles, released, olang, developers, platforms, image,
        rating, votecount, popularity, length, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vndb_id) DO UPDATE SET
       title = excluded.title, titles = excluded.titles, released = excluded.released,
       olang = excluded.olang, developers = excluded.developers, platforms = excluded.platforms,
       image = excluded.image, rating = excluded.rating, votecount = excluded.votecount,
       popularity = excluded.popularity, length = excluded.length, updated_at = excluded.updated_at`,
    [String(vn.id || ''), vn.title || '', titles, vn.released || '', vn.olang || '', devs, plats, image,
     vn.rating || 0, vn.votecount || 0, vn.popularity || 0, vn.length || 0, now, now]
  );
}

function rowToItem(row, today) {
  const titles = parseJson(row.titles, []);
  const devs = parseJson(row.developers, []);
  const plats = parseJson(row.platforms, []);
  const info = pickTitle(titles, row.title);
  return {
    vndbId: row.vndb_id,
    title: info.display,
    native: info.native,
    romanized: info.latin,
    released: row.released || '',
    dateText: dateLabel(row.released, today),
    lang: row.olang || '',
    langLabel: LANG_LABELS[row.olang] || String(row.olang || '').toUpperCase(),
    developers: devs,
    platforms: plats,
    image: row.image || '',
    rating: row.rating || 0,
    votecount: row.votecount || 0,
    length: row.length || 0,
    bgmId: row.bgm_id || 0,
    inLibrary: !!(row.bgm_id),
    // VNDB id 本身带 v 前缀（如 v123），拼 URL 时避免重复
    vndbUrl: 'https://vndb.org/' + (String(row.vndb_id).startsWith('v') ? row.vndb_id : 'v' + row.vndb_id)
  };
}

// 窗口内查询（recent DESC / upcoming ASC），带「库内是否已有」标记
async function queryWindow(from, to, dir, limit, today) {
  const order = dir === 'ASC' ? 'ORDER BY c.released ASC, c.votecount DESC, c.vndb_id'
    : 'ORDER BY c.released DESC, c.votecount DESC, c.vndb_id';
  const where = 'c.released >= ? AND c.released <= ? AND c.olang IN (' + LANG_PH + ')';
  const params = [from, to, ...CORE_LANGS];
  const [rows] = await pool.query(
    `SELECT c.*, m.bgm_id FROM vndb_release_calendar c ${LIB_MATCH_SQL} WHERE ${where} ${order} LIMIT ?`,
    [...params, limit]
  );
  const [tot] = await pool.query(
    `SELECT COUNT(*) AS n FROM vndb_release_calendar c ${LIB_MATCH_SQL} WHERE ${where}`,
    params
  );
  return { items: (rows || []).map(r => rowToItem(r, today)), total: Number((tot[0] && tot[0].n) || 0) };
}

// ---------- 主扫描 ----------
// 增量拉 VNDB 发售窗口 -> upsert -> 清理老行 -> 新作速报
async function scanOnce(opts = {}) {
  if (busy) return { ok: false, reason: 'already running' };
  busy = true;
  const t0 = Date.now();
  try {
    const state = (await rssconfig.getSetting(STATE_KEY, {})) || {};
    const firstRun = !state.lastRunAt;
    const today = todayStr(opts.now);
    const from = addDays(today, -(firstRun ? FIRST_BACK_DAYS : SCAN_BACK_DAYS));
    const to = addDays(today, SCAN_FORWARD_DAYS);
    const now = Date.now();
    const stats = { from, to, pages: 0, fetched: 0, saved: 0 };
    let page = 1;
    for (;;) {
      let data;
      try {
        data = await vndb.apiPost('vn', {
          filters: [
            'and',
            ['released', '>=', from],
            ['released', '<=', to],
            ['or', ...CORE_LANGS.map(l => ['olang', '=', l])]
          ],
          fields: API_FIELDS,
          sort: 'released',
          reverse: true,
          results: 100,
          page
        });
      } catch (e) {
        // 单页失败整体中止（下轮重试）；状态里记 error
        throw e;
      }
      stats.pages++;
      for (const vn of (data.results || [])) {
        const id = String(vn.id || '');
        if (!id || !vn.olang || !CORE_LANGS.includes(vn.olang)) continue; // 语言兜底过滤
        stats.fetched++;
        await upsertRow(vn, now);
        stats.saved++;
      }
      if (!data.more) break;
      if (page >= MAX_PAGES) break;
      page++;
    }
    const pruned = await pruneOld(today);
    const nextState = { lastRunAt: new Date().toISOString(), lastStats: stats, pruned };
    await rssconfig.setSetting(STATE_KEY, nextState);
    let digest = { sent: false, count: 0 };
    if (opts.digest !== false) digest = await sendDigest(today);
    last = { at: now, ok: true, stats, digest };
    console.log('[releasecal] 扫描完成 pages=' + stats.pages + ' saved=' + stats.saved + ' pruned=' + pruned + ' digest=' + digest.count);
    return { ok: true, stats, digest, pruned, elapsedMs: Date.now() - t0 };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 500);
    const prev = (await rssconfig.getSetting(STATE_KEY, {})) || {};
    await rssconfig.setSetting(STATE_KEY, { ...prev, lastErrorAt: new Date().toISOString(), lastError: msg });
    last = { at: Date.now(), ok: false, error: msg };
    console.error('[releasecal] 扫描失败:', msg);
    return { ok: false, error: msg };
  } finally {
    busy = false;
  }
}

async function pruneOld(today) {
  try {
    const keepFrom = addDays(today, -KEEP_DAYS);
    const [r] = await pool.query('DELETE FROM vndb_release_calendar WHERE released < ?', [keepFrom]);
    return Number((r && r[0] && r[0].affectedRows) || 0);
  } catch (e) { return 0; }
}

// 新作速报：把近 NOTIFY_BACK_DAYS 天发售、还没推送过的行汇总走站长通知通道推一次，然后标记 seen
async function sendDigest(today) {
  try {
    const from = addDays(today, -NOTIFY_BACK_DAYS);
    const [rows] = await pool.query(
      `SELECT c.*, m.bgm_id FROM vndb_release_calendar c ${LIB_MATCH_SQL}
       WHERE c.seen = 0 AND c.released >= ? AND c.released <= ? AND c.olang IN (${LANG_PH})
       ORDER BY c.released DESC, c.votecount DESC, c.vndb_id LIMIT 40`,
      [from, today, ...CORE_LANGS]
    );
    if (!rows || !rows.length) return { sent: false, count: 0 };
    const ids = rows.map(r => r.vndb_id);
    await pool.query(
      'UPDATE vndb_release_calendar SET seen = 1 WHERE vndb_id IN (' + ids.map(() => '?').join(',') + ')',
      ids
    );
    const lines = rows.map((r) => {
      const item = rowToItem(r, today);
      const date = String(r.released || '').slice(5).replace('-', '/'); // MM/DD
      const dev = item.developers[0] ? '（' + item.developers[0] + '）' : '';
      return '· ' + date + ' ' + item.title + dev + (item.inLibrary ? ' ⭐ 库内已有' : '');
    });
    const title = '🎮 VNDB 新作速报 · 近' + NOTIFY_BACK_DAYS + '天 ' + rows.length + ' 款';
    const body = 'Galgame 新作/已发售条目（源：VNDB，只含日/中/韩原语）\n\n' + lines.join('\n') +
      '\n\n在线浏览：' + (process.env.PUBLIC_BASE || '') + '/anime?cat=galgame';
    const sent = await notify.notify(title, body);
    return { sent, count: rows.length };
  } catch (e) {
    console.error('[releasecal] 新作速报失败:', e.message);
    return { sent: false, count: 0, error: String(e.message || e).slice(0, 300) };
  }
}

// ---------- 对外 API ----------
async function getCalendar({ recentDays = 30, upcomingDays = 45, limit = 18 } = {}) {
  const today = todayStr();
  const recentFrom = addDays(today, -Math.min(Math.max(+(recentDays) || 30, 7), 120));
  const upcomingTo = addDays(today, Math.min(Math.max(+(upcomingDays) || 45, 7), 180));
  const lim = Math.min(Math.max(+(limit) || 18, 1), 60);
  const [recent, upcoming, state] = await Promise.all([
    queryWindow(recentFrom, today, 'DESC', lim, today),
    queryWindow(addDays(today, 1), upcomingTo, 'ASC', lim, today),
    rssconfig.getSetting(STATE_KEY, {})
  ]);
  return {
    source: 'vndb',
    recent: recent.items,
    recentTotal: recent.total,
    upcoming: upcoming.items,
    upcomingTotal: upcoming.total,
    stats: { lastRunAt: state.lastRunAt || null, lastError: state.lastError || null }
  };
}

async function getStatus() {
  const state = (await rssconfig.getSetting(STATE_KEY, {})) || {};
  const summary = { total: 0, recent30: 0, upcoming: 0, unseen: 0, matched: 0 };
  try {
    const today = todayStr();
    const [a] = await pool.query('SELECT COUNT(*) AS n FROM vndb_release_calendar');
    summary.total = Number((a[0] && a[0].n) || 0);
    const [b] = await pool.query(
      `SELECT COUNT(*) AS n FROM vndb_release_calendar c WHERE c.released >= ? AND c.released <= ?`,
      [addDays(today, -30), today]
    );
    summary.recent30 = Number((b[0] && b[0].n) || 0);
    const [c] = await pool.query('SELECT COUNT(*) AS n FROM vndb_release_calendar c WHERE c.released > ?', [today]);
    summary.upcoming = Number((c[0] && c[0].n) || 0);
    const [d] = await pool.query('SELECT COUNT(*) AS n FROM vndb_release_calendar c WHERE c.seen = 0');
    summary.unseen = Number((d[0] && d[0].n) || 0);
    const [e] = await pool.query(
      `SELECT COUNT(DISTINCT c.vndb_id) AS n FROM vndb_release_calendar c
       INNER JOIN (SELECT source_id FROM library_source_map WHERE source = 'vndb' AND status = 'ok') m ON m.source_id = c.vndb_id`
    );
    summary.matched = Number((e[0] && e[0].n) || 0);
  } catch (err) { /* 状态汇总失败不阻塞 */ }
  return {
    module: 'releasecal',
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
  // 启动 20s 后先跑一轮（错开 VNDB 回填/启动高峰），之后每 6h 一次
  bootTimer = setTimeout(() => { runOnce().catch(() => {}); }, 20 * 1000);
  intervalTimer = setInterval(() => { runOnce().catch(() => {}); }, SCAN_INTERVAL_MS);
}

function runOnce(opts) {
  return scanOnce(opts || {});
}

module.exports = {
  scanOnce, runOnce, startScheduler, getCalendar, getStatus,
  todayStr, addDays, dateLabel, pickTitle
};
