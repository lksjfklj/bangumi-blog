// backfill-bgm.cjs - 为 anime_episodes 补齐 bgm_subject_id（一次性/可重跑维护脚本）
// 用法: node backfill-bgm.cjs [--dry-run] [--limit N] [--sleep MS]
// 运行目录需为 backend/（读取 .env 与 ../src/*）
const { DatabaseSync } = require('node:sqlite');
const config = require('../src/config');
const { bgm, cached } = require('../src/bangumi');
const { norm, stripSeason, snorm } = require('../src/title');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
let limit = 0, sleepMs = 1200;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit') limit = +args[i + 1] || 0;
  if (args[i] === '--sleep') sleepMs = +args[i + 1] || 1200;
}

const db = new DatabaseSync(config.db.file);

// 严格包含：短侧 >= 5 字且占比 >= 60%，避免「异世界」「再见」这类短词误配
const strictInc = (x, y) => {
  if (x.length < 5 || y.length < 5) return false;
  const sh = Math.min(x.length, y.length), lo = Math.max(x.length, y.length);
  return sh >= lo * 0.6 && (x.includes(y) || y.includes(x));
};

// ---------- 1. collections 缓存 ----------
const cache = new Map();
{
  const rows = db.prepare(`SELECT DISTINCT subject_id, name, name_cn FROM collections
    WHERE (name IS NOT NULL AND name != '') OR (name_cn IS NOT NULL AND name_cn != '')`).all();
  for (const c of rows) {
    for (const n of [c.name, c.name_cn]) {
      if (!n) continue;
      for (const k of [norm(n), snorm(n)]) {
        if (k && !cache.has(k)) cache.set(k, c.subject_id);
      }
    }
  }
  console.log('[backfill] collections cache entries:', cache.size);
}

// ---------- 2. 标题候选 ----------
const TECH_TAIL = /\b(?:GB|BIG5|BIG-5|CHT|CHS|JP|CN|AV1|AVC|HEVC|H\.?26[45]|x26[45]|WEB\s*RIP|WEB\s*DL|BD\s*RIP|REMUX|REPACK|SUBFRENCH|VOSTFR|VOST|MULTI\s*SUBS|MULTI|ADN|CR|AAC2?\.?0?|FLAC|AC3|OPUS|DDP|5\.1|2\.0|READNFO|NCOP|NCED|PV|CM|SP|OVA|OAD)\b/gi;
function cleanSeg(seg) {
  let s = String(seg || '').trim();
  s = s.replace(/[（(][^（）()]*[）)]/g, ' ');
  s = s.replace(/20\d{2}\s*年\s*[0-9０-９]{1,2}\s*月\s*番?/g, ' ');
  s = s.replace(/\d{4}[./-]\d{1,2}[./-]\d{1,2}/g, ' ');
  s = s.replace(/(?:第)?\s*[0-9０-９]{1,2}\s*期\b|\bS[0-9]{1,2}\b|\b第\s*[0-9０-９一二三四五六七八九十]{1,2}\s*[季期]\b/g, ' ');
  s = s.replace(TECH_TAIL, ' ');
  s = s.replace(/[★☆◇◆\s]+$/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^\s*[-–—_・~]+\s*|\s*[-–—_・~]+\s*$/g, ' ').trim();
  return s;
}
function cjkRun(str) {
  let best = '', cur = '';
  for (const ch of String(str)) {
    if (/[\u4e00-\u9fff]/.test(ch)) { cur += ch; if (cur.length > best.length) best = cur; }
    else cur = '';
  }
  return best;
}
function extractCandidates(seriesTitle) {
  const out = [];
  const push = x => { const c = cleanSeg(x); if (c && !out.includes(c)) out.push(c); };
  const segs = String(seriesTitle || '').split(/[\/／]/).map(x => x.trim()).filter(Boolean);
  for (const seg of segs) {
    push(seg);
    const cs = cleanSeg(seg);
    const st = stripSeason(cs);
    if (st && st !== cs) push(st);
  }
  push(seriesTitle);
  for (const seg of segs.concat([seriesTitle])) {
    const run = cjkRun(seg);
    if (run && run.length >= 2) push(run);
  }
  for (const seg of segs) {
    const run = cjkRun(seg);
    if (run && run.length > 10) push(run.slice(0, 8));
  }
  const hasCjk = x => /[\u4e00-\u9fff]/.test(x);
  const cjk = out.filter(hasCjk), other = out.filter(x => !hasCjk(x));
  return cjk.concat(other).slice(0, 5);
}

// ---------- 3. 匹配 ----------
function cacheLookup(cands) {
  for (const c of cands) {
    for (const k of [norm(c), snorm(c)]) {
      if (cache.has(k)) return cache.get(k);
    }
  }
  for (const c of cands) {
    for (const k of [norm(c), snorm(c)]) {
      for (const [ck, sid] of cache) {
        if (strictInc(k, ck)) return sid;
      }
    }
  }
  return 0;
}
async function searchMatch(cands) {
  for (const c of cands) {
    let data;
    try {
      data = await cached('bgm:search:anime:' + norm(c), 30 * 24 * 3600 * 1000, () =>
        bgm('/search/subject/' + encodeURIComponent(String(c).slice(0, 60)) + '?type=2')
      );
    } catch (e) { continue; }
    const list = (data && Array.isArray(data.list)) ? data.list : ((data && Array.isArray(data.data)) ? data.data : []);
    if (!list.length) continue;
    const ck = norm(c), csk = snorm(c);
    const names = [];
    for (const it of list) {
      const ns = [];
      if (it.name) ns.push(it.name);
      if (it.name_cn) ns.push(it.name_cn);
      for (const n of ns) {
        const a = norm(n), b = snorm(n);
        if (a === ck || a === csk || b === ck || b === csk) return it.id;
        names.push([it.id, a, b]);
      }
    }
    for (const [sid, a, b] of names) {
      if (strictInc(a, ck) || strictInc(a, csk) || strictInc(b, ck) || strictInc(b, csk)) return sid;
    }
    const cjk = String(c).replace(/[^\u4e00-\u9fff]/g, '');
    if (cjk.length >= 5) {
      const want = new Set(cjk);
      let best = 0, bestSid = 0;
      for (let i = 0; i < Math.min(list.length, 8); i++) {
        const it = list[i];
        const n = snorm(it.name_cn || it.name || '');
        const got = new Set(n.replace(/[^\u4e00-\u9fff]/g, ''));
        let common = 0;
        for (const ch of want) if (got.has(ch)) common++;
        if (common >= 4 && common / want.size >= 0.8 && common > best) { best = common; bestSid = it.id; }
      }
      if (bestSid) return bestSid;
    }
  }
  return 0;
}

// ---------- 4. 主流程 ----------
(async () => {
const rows = db.prepare(`SELECT series_key, series_title, COUNT(*) n
  FROM anime_episodes WHERE series_key != '' AND bgm_subject_id IS NULL
  GROUP BY series_key ORDER BY n DESC`).all();
console.log('[backfill] unmatched series:', rows.length, dryRun ? '(DRY-RUN)' : '');
const todo = limit ? rows.slice(0, limit) : rows;

let matched = 0, apiCalls = 0, failed = 0;
const missed = [];
const seenKey = new Set();
for (let i = 0; i < todo.length; i++) {
  const r = todo[i];
  if (seenKey.has(r.series_key)) continue;
  seenKey.add(r.series_key);
  const cands = extractCandidates(r.series_title);
  let sid = cacheLookup(cands);
  if (!sid) {
    apiCalls++;
    sid = await searchMatch(cands);
    if (sleepMs > 0) await new Promise(res => setTimeout(res, sleepMs));
  }
  if (sid) {
    matched++;
    if (!dryRun) {
      db.prepare('UPDATE anime_episodes SET bgm_subject_id = ? WHERE series_key = ? AND bgm_subject_id IS NULL')
        .run(sid, r.series_key);
      for (const c of cands) for (const k of [norm(c), snorm(c)]) if (k && !cache.has(k)) cache.set(k, sid);
    }
    if (matched % 10 === 0) console.log('[backfill] progress matched', matched, '/', i + 1);
  } else {
    failed++;
    if (missed.length < 60) missed.push(r.series_title);
  }
  if ((i + 1) % 25 === 0) console.log('[backfill] processed', i + 1, 'series, matched', matched, 'apiCalls', apiCalls);
}
console.log('---');
console.log('[backfill] done. total', todo.length, 'matched', matched, 'missed', failed, 'apiCalls', apiCalls);
console.log('[backfill] missed sample:');
for (const m of missed) console.log('  -', m);
})().catch(e => { console.error(e); process.exit(1); });
