// library.js - 书籍库（漫画/轻小说）全量同步与查询
// 数据源：Bangumi v0 API /v0/subjects?type=1（书籍全量，含 platform/tags/meta_tags/rating）
// 分类规则：platform=漫画 -> 漫画；platform=小说 且 标签含「轻小说」 -> 轻小说
// 地区规则：按每本书的用户标签判定；明确标注为非中日韩地区的条目标记 blocked=1 排除；
//          未标注地区的条目保留（bgm 书籍库以中日韩为主），前端可用「地区」筛选只看已确认的中日韩。
const { bgm } = require('./bangumi');
const { pool } = require('./db');

// 允许地区（中，含香港台湾；日；韩）
const ALLOWED_REGIONS = ['日本', '中国', '韩国', '台湾', '香港'];
// bgm 书籍标签中实际出现的地区标签全集（用于排除非中日韩）
const REGION_TAGS = ['日本', '中国', '韩国', '台湾', '香港', '美国', '法国', '英国', '德国', '泰国', '俄罗斯', '意大利', '西班牙', '加拿大', '马来西亚', '印度', '巴西', '澳大利亚', '新加坡'];

const CATEGORY_PLATFORM = { manga: '漫画', lightnovel: '轻小说' };
const CATEGORY_SQL = { manga: "category = 'manga'", lightnovel: "category = 'lightnovel'" };

let syncing = false;
let lastSync = null; // { ok, at, counts }

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function tagNames(item) {
  const set = new Set();
  for (const t of (item.tags || [])) if (t && t.name) set.add(t.name);
  for (const m of (item.meta_tags || [])) if (m) set.add(m);
  return set;
}

function regionsOf(item) {
  const names = tagNames(item);
  return REGION_TAGS.filter(r => names.has(r));
}

// 返回 'manga' | 'lightnovel' | null
function classify(item) {
  const platform = item.platform || '';
  const names = tagNames(item);
  if (platform === '漫画') return 'manga';
  if (platform === '小说' && names.has('轻小说')) return 'lightnovel';
  return null;
}

// 是否应排除：有地区标签但没有任何允许地区（即明确非中日韩）
function isBlocked(regions) {
  if (!regions || !regions.length) return 0;
  return regions.some(r => ALLOWED_REGIONS.includes(r)) ? 0 : 1;
}

function toRow(category, item) {
  const regions = regionsOf(item);
  const imgs = item.images || {};
  const rating = item.rating || {};
  return {
    subject_id: item.id,
    category,
    name: item.name || '',
    name_cn: item.name_cn || '',
    image: imgs.common || imgs.medium || imgs.large || '',
    air_date: item.date || '',
    rating_score: rating.score || 0,
    rating_total: rating.total || 0,
    rank: rating.rank || 0,
    platform: item.platform || '',
    tags: JSON.stringify([...tagNames(item)]),
    regions: JSON.stringify(regions),
    blocked: isBlocked(regions),
    updated_at: Date.now()
  };
}

// 拉取全部书籍（type=1，rank 排序，offset 分页）
async function fetchAllBooks(onBatch) {
  const limit = 50;
  let offset = 0;
  let total = 0;
  for (;;) {
    let data;
    try {
      data = await bgm(`/v0/subjects?type=1&sort=rank&offset=${offset}&limit=${limit}`);
    } catch (e) {
      // 失败重试一次（网络/限流），仍失败则抛错终止本次同步
      await delay(600);
      data = await bgm(`/v0/subjects?type=1&sort=rank&offset=${offset}&limit=${limit}`);
    }
    const batch = (data && data.data) || (Array.isArray(data) ? data : []);
    if (!batch.length) break;
    total += batch.length;
    if (onBatch) await onBatch(batch);
    if (batch.length < limit) break;
    offset += limit;
    await delay(60); // 轻微限速，避免触发反爬
  }
  return total;
}

// 全量同步入库
async function runSync() {
  if (syncing) return { ok: false, reason: 'already syncing' };
  syncing = true;
  const started = Date.now();
  const counts = { manga: 0, lightnovel: 0, total: 0, blocked: 0 };
  try {
    await setMeta('status', 'syncing');
    await fetchAllBooks(async (batch) => {
      const stmt = pool.getConnection();
      try {
        for (const item of batch) {
          const category = classify(item);
          if (!category) continue;
          const row = toRow(category, item);
          counts[category] += 1;
          counts.total += 1;
          if (row.blocked) counts.blocked += 1;
          await stmt.query(
            `INSERT INTO library_subjects (subject_id, category, name, name_cn, image, air_date, rating_score, rating_total, rank, platform, tags, regions, blocked, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(subject_id, category) DO UPDATE SET
               name = excluded.name, name_cn = excluded.name_cn, image = excluded.image,
               air_date = excluded.air_date, rating_score = excluded.rating_score,
               rating_total = excluded.rating_total, rank = excluded.rank, platform = excluded.platform,
               tags = excluded.tags, regions = excluded.regions, blocked = excluded.blocked,
               updated_at = excluded.updated_at`,
            [row.subject_id, row.category, row.name, row.name_cn, row.image, row.air_date,
             row.rating_score, row.rating_total, row.rank, row.platform, row.tags, row.regions, row.blocked, row.updated_at]
          );
        }
      } finally {
        stmt.release();
      }
    });
    lastSync = { ok: true, at: new Date().toISOString(), counts };
    await setMeta('status', 'done');
    await setMeta('last_run', lastSync.at);
    await setMeta('counts', JSON.stringify(counts));
    return { ok: true, counts, elapsedMs: Date.now() - started };
  } catch (e) {
    lastSync = { ok: false, at: new Date().toISOString(), error: e.message };
    await setMeta('status', 'error');
    await setMeta('last_error', e.message);
    return { ok: false, error: e.message };
  } finally {
    syncing = false;
  }
}

async function setMeta(key, value) {
  try {
    await pool.query(
      'INSERT INTO library_sync (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, String(value)]
    );
  } catch (e) { /* ignore */ }
}

async function getMeta(key) {
  try {
    const [rows] = await pool.query('SELECT value FROM library_sync WHERE key = ?', [key]);
    return rows.length ? rows[0].value : '';
  } catch (e) { return ''; }
}

// 首次启动/每日定时：若库为空或距上次同步超过 12 小时则同步
async function ensureSync() {
  if (syncing) return;
  try {
    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM library_subjects');
    const empty = !rows[0].n;
    const last = await getMeta('last_run');
    const stale = !last || (Date.now() - new Date(last).getTime() > 12 * 3600 * 1000);
    if (empty || stale) {
      await runSync();
    }
  } catch (e) { console.error('[library] ensureSync fail:', e.message); }
}

async function syncStatus() {
  // 进程重启后内存态丢失，从数据库恢复上次同步状态
  let restored = null;
  try {
    const status = await getMeta('status');
    const last = await getMeta('last_run');
    if (last) {
      let counts = null;
      try { counts = JSON.parse(await getMeta('counts') || 'null'); } catch (e) {}
      restored = { ok: status === 'done', at: last, counts };
    }
  } catch (e) { /* ignore */ }
  return { syncing, lastSync: lastSync || restored, meta: null };
}

// 书籍库分页查询（category 必须为 manga/lightnovel）
async function queryLibrary({ category, page = 1, limit = 24, sort = 'rank', keyword = '', tag = '', year = '', region = '' }) {
  const where = [CATEGORY_SQL[category], 'blocked = 0'];
  const params = [];
  const kw = String(keyword).trim();
  if (kw) {
    where.push('(name LIKE ? OR name_cn LIKE ?)');
    const like = `%${kw}%`;
    params.push(like, like);
  }
  if (tag) {
    where.push('tags LIKE ?');
    params.push(`%"${tag}"%`);
  }
  if (/^\d{4}$/.test(year)) {
    where.push("substr(air_date, 1, 4) = ?");
    params.push(year);
  }
  if (region) {
    if (region === '未标注') {
      where.push("regions = '[]'");
    } else {
      where.push('regions LIKE ?');
      params.push(`%"${region}"%`);
    }
  }
  const whereSql = where.join(' AND ');
  const [totalRows] = await pool.query(`SELECT COUNT(*) AS n FROM library_subjects WHERE ${whereSql}`, params);
  const total = totalRows[0].n;
  const lastPage = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(Math.max(page, 1), lastPage);
  const offset = (safePage - 1) * limit;
  const order = sort === 'title' ? 'ORDER BY name_cn ASC, name ASC'
    : sort === 'rating' ? 'ORDER BY rating_score DESC, rating_total DESC'
    : 'ORDER BY rank ASC, rating_score DESC';
  const [rows] = await pool.query(
    `SELECT subject_id AS id, category, name, name_cn, image, air_date,
            rating_score, rating_total, rank, platform, tags, regions
     FROM library_subjects WHERE ${whereSql} ${order} LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const list = rows.map(r => {
    let tags = [], regions = [];
    try { tags = JSON.parse(r.tags || '[]'); } catch (e) {}
    try { regions = JSON.parse(r.regions || '[]'); } catch (e) {}
    const imgs = r.image ? { common: r.image, medium: r.image, large: r.image, grid: r.image, small: r.image } : undefined;
    return {
      id: r.id,
      type: 1,
      category: r.category,
      name: r.name,
      name_cn: r.name_cn || r.name,
      images: imgs,
      air_date: r.air_date,
      rating: r.rating_total ? { score: r.rating_score, total: r.rating_total } : undefined,
      rank: r.rank || undefined,
      platform: r.platform,
      tags,
      regions
    };
  });
  return { data: list, total, page: safePage, limit, totalPages: lastPage, source: 'local' };
}

// 启动定时：进程启动后延时 5s 同步一次（不阻塞启动），之后每 12 小时一次
let timer = null;
function startScheduler() {
  if (timer) return;
  setTimeout(() => { ensureSync().catch(() => {}); }, 5000);
  timer = setInterval(() => { ensureSync().catch(() => {}); }, 12 * 3600 * 1000);
}

async function getStatus() {
  let s = null;
  try { s = await syncStatus(); } catch (e) {}
  return {
    module: 'library',
    syncing: !!(s && s.syncing),
    lastSync: s && s.lastSync ? { ok: !!s.lastSync.ok, at: s.lastSync.at, counts: s.lastSync.counts } : null
  };
}

module.exports = { runSync, ensureSync, startScheduler, syncStatus, queryLibrary, classify, regionsOf, getStatus };
