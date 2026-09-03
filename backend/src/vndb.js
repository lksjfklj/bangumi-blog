// vndb.js - VNDB API v2「Kana」客户端 + 标题匹配工具（Galgame 增强数据源）
// 定位：底库仍是 Bangumi（登录/收藏/浏览不换），VNDB 只负责补全/校准 galgame 条目的
//       别名、开发商、发行日期、评分热度、封面、平台、时长等结构化元数据。
// 端点说明：VNDB v2 需要在 https://api.vndb.org/kana 后追加资源后缀再 POST（如 /kana/vn）。
//          服务器实测直连偶发超时、走 clash 代理稳定，因此带「代理优先 + 直连兜底」双通道。
const { fetch, ProxyAgent } = require('undici');
const config = require('./config');

const API_BASE = 'https://api.vndb.org/kana';
// 匿名访问限速保守间隔（VNDB 对匿名请求限制较严）
const MIN_GAP_MS = 1000;
// 搜索时拉取的字段：标题族（title/alttitle/titles/aliases）用于跨语言匹配，
// 其余（发行/评分/热度/平台/开发商/封面/时长）用于回填库内 ext。
const SEARCH_FIELDS =
  'id, title, alttitle, titles.lang, titles.title, titles.latin, aliases, released, rating, votecount, popularity, platforms, developers.name, olang, image.url, length';

let proxyDispatcher = null;
if (config.bangumi.proxy) {
  try { proxyDispatcher = new ProxyAgent(config.bangumi.proxy); } catch (e) { proxyDispatcher = null; }
}

class VndbError extends Error {
  constructor(status, message) {
    super('VNDB API error: ' + status + ' ' + (message || ''));
    this.status = status;
    this.snippet = String(message || '').slice(0, 200);
  }
}

let nextAllowedAt = 0;
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
async function throttle() {
  const now = Date.now();
  if (now < nextAllowedAt) await delay(nextAllowedAt - now);
  nextAllowedAt = Date.now() + MIN_GAP_MS;
}

// POST /kana/<type>（type: vn/release/producer/tag…）
async function apiPost(type, body) {
  await throttle();
  const options = {
    method: 'POST',
    headers: {
      'User-Agent': config.bangumi.userAgent || 'bangumi-blog/1.0 (personal site)',
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(25000)
  };
  // 代理通道在前、直连兜底（未配置代理则仅直连）
  const attempts = proxyDispatcher
    ? [{ ...options, dispatcher: proxyDispatcher }, { ...options }]
    : [{ ...options }];
  let lastErr = null;
  for (const opt of attempts) {
    let res;
    try {
      res = await fetch(API_BASE + '/' + type, opt);
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (res.ok) return res.json();
    const text = await res.text().catch(() => '');
    // 服务器繁忙/被限流：换通道重试一次
    if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
      lastErr = new VndbError(res.status, text);
      await delay(2500);
      continue;
    }
    throw new VndbError(res.status, text);
  }
  if (lastErr instanceof VndbError) throw lastErr;
  throw new VndbError(0, lastErr && lastErr.message ? lastErr.message : 'network error');
}

// 按 vndb id 精确拉取单条（字段与搜索一致，用于刷新已匹配条目的最新评分/热度/封面）
async function vnById(id) {
  if (!id) return null;
  const data = await apiPost('vn', {
    filters: ['id', '=', String(id)],
    fields: SEARCH_FIELDS,
    results: 1
  });
  return data && Array.isArray(data.results) && data.results.length ? data.results[0] : null;
}

// VNDB 标题搜索（返回命中条目数组）
async function vnSearch(query, { limit = 6 } = {}) {
  const body = {
    filters: ['search', '=', query],
    fields: SEARCH_FIELDS,
    results: limit,
    sort: 'searchrank'
  };
  try {
    const data = await apiPost('vn', body);
    return (data && Array.isArray(data.results) ? data.results : []);
  } catch (e) {
    // 「Too much data selected」：字段过重（个别条目别名巨多），降级为精简字段重试一次
    if (e && e.snippet && /too much data/i.test(e.snippet)) {
      const data = await apiPost('vn', {
        filters: ['search', '=', query],
        fields: 'id, title, alttitle, titles.lang, titles.title, titles.latin, released, rating, votecount, image.url',
        results: Math.min(3, limit),
        sort: 'searchrank'
      });
      return (data && Array.isArray(data.results) ? data.results : []);
    }
    throw e;
  }
}

// ---------- 标题匹配工具（纯函数，便于单测） ----------
// 归一化：NFKC + 去变音符 + 只保留字母/数字（去掉空格、标点、破折号、日文中点等）
function normalizeTitle(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

// 编辑距离（用于标题相似度）
function levenshtein(a, b) {
  const la = a.length, lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1);
    cur[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[lb];
}

// 二元组 Dice 系数
function diceCoeff(a, b) {
  const grams = (s) => {
    const set = new Set();
    if (s.length < 2) { set.add(s); return set; }
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(a), B = grams(b);
  if (!A.size && !B.size) return a === b ? 1 : 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// 两条归一化标题的相似度 0..1（完全相等=1；子串包含、编辑距离、bigram 取最大）
function scorePair(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  let short = a, long = b;
  if (la > lb) { short = b; long = a; }
  if (long.includes(short)) return Math.round((0.65 + 0.35 * (short.length / long.length)) * 1000) / 1000;
  const lev = 1 - levenshtein(a, b) / Math.max(la, lb);
  const dice = diceCoeff(a, b);
  return Math.round(Math.max(lev, dice) * 1000) / 1000;
}

// 候选年份是否与条目发行年份一致（bgm 无年份时返回 null，不参与年份闸门）
function yearMatches(vn, year) {
  if (!year) return null;
  const rel = String((vn && vn.released) || '');
  const m = rel.match(/^(\d{4})/);
  if (!m) return null;
  return m[1] === String(year);
}

// 从 VNDB 搜索结果里挑最可能的同一条目。
// 候选标题来自 title / alttitle / titles(各语言原名+罗马音) / aliases，覆盖 中文名-日文名-罗马音 跨语言对照。
// 返回 { vn, score, matchedName, yearOk } 或 null（无结果）。
function pickBestVn(results, { names = [], year = '' } = {}) {
  const qNorms = [];
  for (const n of names || []) {
    const norm = normalizeTitle(n);
    if (norm && !qNorms.includes(norm)) qNorms.push(norm);
  }
  if (!qNorms.length) return null;
  let best = null;
  for (const vn of results || []) {
    if (!vn || !vn.id) continue;
    const cands = new Set();
    if (vn.title) cands.add(vn.title);
    if (vn.alttitle) cands.add(vn.alttitle);
    for (const t of vn.titles || []) {
      if (t && t.title) cands.add(t.title);
      if (t && t.latin) cands.add(t.latin);
    }
    for (const a of (vn.aliases || []).slice(0, 40)) if (a) cands.add(a);
    let score = 0, matched = '';
    for (const q of qNorms) {
      for (const c of cands) {
        const nc = normalizeTitle(c);
        if (!nc) continue;
        const s = scorePair(q, nc);
        if (s > score) { score = s; matched = c; }
      }
    }
    if (!best || score > best.score) best = { vn, score, matchedName: matched };
  }
  if (!best || best.score <= 0) return null;
  best.yearOk = yearMatches(best.vn, year);
  return best;
}

// 判定某次匹配是否可信（ok + reason）
function matchDecision(pick) {
  if (!pick) return { ok: false, reason: 'no-result' };
  const { score, yearOk } = pick;
  if (score >= 0.999) return { ok: true, reason: 'exact' };
  if (score >= 0.9 && yearOk !== false) return { ok: true, reason: 'high-sim' };
  if (score >= 0.8 && yearOk === true) return { ok: true, reason: 'sim+year' };
  return { ok: false, reason: score >= 0.8 ? 'year-mismatch' : 'low-score' };
}

// 收敛为入库用的精简 JSON（存 library_subjects.ext.vndb）
function summarizeVn(vn) {
  if (!vn) return null;
  const devs = (vn.developers || []).map(d => (d && d.name) || '').filter(Boolean);
  const plats = (vn.platforms || []).slice(0, 12);
  return {
    id: vn.id,
    title: vn.title || '',
    alttitle: vn.alttitle || '',
    released: vn.released || '',
    rating: vn.rating || 0,
    votecount: vn.votecount || 0,
    popularity: vn.popularity || 0,
    length: vn.length || 0,
    olang: vn.olang || '',
    platforms: plats,
    developers: devs,
    aliases: (vn.aliases || []).slice(0, 20),
    image: (vn.image && vn.image.url) || ''
  };
}

module.exports = { apiPost, vnSearch, vnById, normalizeTitle, scorePair, pickBestVn, matchDecision, summarizeVn, yearMatches };

