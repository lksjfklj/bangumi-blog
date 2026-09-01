// routes/collections.js - 追番收藏：本地存储 + Bangumi 双向同步
const express = require('express');
const { bgm, cached, getValidToken } = require('../bangumi');
const { pool } = require('../db');
const { requireAuth, requireNotViewer } = require('../auth');
const router = express.Router();
router.use('/me', requireAuth);
router.use('/collections', requireAuth, requireNotViewer);

const STATUS_TEXT = { 1: '想看', 2: '看过', 3: '在看', 4: '搁置', 5: '抛弃' };

function parseTags(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  if (typeof v === 'string') {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a : [];
    } catch (e) { /* 不是 JSON，按逗号拆分 */ }
    return v.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

// 条目/社区标签转名称数组
function subjectTagNames(s) {
  if (!s || !Array.isArray(s.tags)) return [];
  return s.tags.map(t => (typeof t === 'string' ? t : t && t.name)).filter(Boolean);
}

// 本地各状态收藏数量统计（可按标签过滤），用于前端 Tab 计数
async function localCounts(userId, subjectType, tags) {
  let where = 'user_id = ?';
  const args = [userId];
  if (subjectType) { where += ' AND subject_type = ?'; args.push(+subjectType); }
  for (const t of tags) { where += ' AND (tags LIKE ? OR subject_tags LIKE ?)'; args.push('%' + t + '%', '%' + t + '%'); }
  const [rows] = await pool.query(`SELECT status, COUNT(*) AS n FROM collections WHERE ${where} GROUP BY status`, args);
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  for (const r of rows) {
    counts[r.status] = r.n;
    total += r.n;
  }
  counts.total = total;
  return counts;
}

// 用户 Bangumi 收藏（分页拉取，含缓存）
async function fetchBgmCollections(uid, token, { status, subjectType, limit = 30, offset = 0 } = {}) {
  const params = new URLSearchParams();
  if (subjectType) params.set('subject_type', subjectType);
  if (status) params.set('type', status);
  params.set('limit', limit);
  params.set('offset', offset);
  const path = `/v0/users/${uid}/collections?` + params.toString();
  return bgm(path, { token });
}

// 我的收藏列表（未指定标签时优先 Bangumi 实时，指定标签或失败时用本地表）
router.get('/me/collections', async (req, res, next) => {
  try {
    const { status, subject_type: subjectType = 2, limit = 30, offset = 0, tag } = req.query;
    const tags = tag ? String(tag).split(',').map(s => s.trim()).filter(Boolean) : [];
    const token = await getValidToken(req.user);
    const counts = await localCounts(req.user.id, +subjectType, tags);

    if (token && tags.length === 0) {
      try {
        const data = await fetchBgmCollections(req.user.bangumi_uid, token, { status, subjectType, limit, offset });
        const items = (data.data || []).map(c => {
          const s = c.subject || {};
          return {
            ...s, ...c,
            id: c.subject_id,
            subject_id: c.subject_id,
            subject_type: s.type || c.subject_type || 2,
            type: s.type || c.subject_type || 2,
            status: c.type,
            name: s.name || c.name || '',
            name_cn: s.name_cn || c.name_cn || '',
            images: s.images || null,
            tags: c.tags || [],
            subject_tags: subjectTagNames(s)
          };
        });
        return res.json({ source: 'bangumi', data: items, total: data.total || items.length, counts, bgmTotal: data.total || items.length });
      } catch (e) {
        // Bangumi 不可用时降级本地
      }
    }

    let where = 'user_id = ?';
    const args = [req.user.id];
    if (status) { where += ' AND status = ?'; args.push(+status); }
    if (subjectType) { where += ' AND subject_type = ?'; args.push(+subjectType); }
    for (const t of tags) { where += ' AND (tags LIKE ? OR subject_tags LIKE ?)'; args.push('%' + t + '%', '%' + t + '%'); }
    const [rows] = await pool.query(`SELECT * FROM collections WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [...args, Math.min(+limit || 30, 50), +offset || 0]);
    const mapped = rows.map(r => ({
      ...r,
      id: r.subject_id,
      subject_type: r.subject_type || 2,
      type: r.subject_type || 2,
      status: r.status,
      images: r.image ? { common: r.image } : null,
      tags: parseTags(r.tags),
      subject_tags: parseTags(r.subject_tags)
    }));
    const [cnt] = await pool.query(`SELECT COUNT(*) AS total FROM collections WHERE ${where}`, args);
    res.json({ source: 'local', data: mapped, total: cnt[0].total, counts });
  } catch (e) { next(e); }
});

// 我的收藏标签统计（用于标签筛选下拉）
router.get('/me/collections/tags', async (req, res, next) => {
  try {
    const { subject_type: subjectType = 2, limit = 60 } = req.query;
    const [rows] = await pool.query(
      'SELECT tags, subject_tags FROM collections WHERE user_id = ? AND subject_type = ?',
      [req.user.id, +subjectType]
    );
    const counter = new Map();
    for (const r of rows) {
      for (const t of [...parseTags(r.tags), ...parseTags(r.subject_tags)]) {
        if (!t) continue;
        counter.set(t, (counter.get(t) || 0) + 1);
      }
    }
    const data = [...counter.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))
      .slice(0, Math.min(+limit || 60, 200));
    res.json({ data });
  } catch (e) { next(e); }
});

// 设置收藏状态（写 Bangumi + 本地）
router.put('/collections/:subjectId', async (req, res, next) => {
  try {
    const subjectId = +req.params.subjectId;
    const { status, score, ep_status: epStatus, comment, tags } = req.body || {};
    const token = await getValidToken(req.user);
    let subject = null;
    try {
      subject = await cached('bgm:subject:' + subjectId, 24 * 3600 * 1000, () => bgm('/v0/subjects/' + subjectId));
    } catch (e) { /* 条目信息拉取失败时降级用本地已有数据 */ }
    // 条目类型：1=书籍（漫画/轻小说/画集），其余为番剧/音乐/游戏/三次元
    let subjectType = subject ? +subject.type : 2;
    let localRow = null;
    if (!subject) {
      const [rows] = await pool.query('SELECT * FROM collections WHERE user_id = ? AND subject_id = ?', [req.user.id, subjectId]);
      localRow = rows[0] || null;
      if (localRow) subjectType = +localRow.subject_type || subjectType;
    }
    // Bangumi v0 API 约束：type 1-5、rate 0-10 整数、仅书籍条目允许设置 vol_status/ep_status
    const type = Math.min(Math.max(+(status || 1), 1), 5);
    const rate = Math.min(Math.max(Math.round(+(score || 0)), 0), 10);
    const body = {
      type,
      rate,
      ...(comment != null ? { comment: String(comment).slice(0, 1000) } : {}),
      ...(tags != null ? { tags: Array.isArray(tags) ? tags.slice(0, 20).map(String) : [] } : {})
    };
    if (subjectType === 1 && epStatus != null) {
      body.ep_status = Math.max(0, Math.round(+(epStatus || 0)));
    }
    // Bangumi 推送失败不阻塞本地保存（返回 bgmSynced 供前端提示）
    let bgmSynced = false;
    if (token) {
      try {
        await bgm(`/v0/users/-/collections/${subjectId}`, { method: 'PATCH', token, body });
        bgmSynced = true;
      } catch (e) { /* 忽略：本地仍保存 */ }
    }
    const tagsArr = Array.isArray(tags) ? tags.slice(0, 20).map(String) : [];
    const name = subject ? (subject.name || '') : (localRow ? localRow.name : '');
    const nameCn = subject ? (subject.name_cn || '') : (localRow ? localRow.name_cn : '');
    const image = subject && subject.images ? (subject.images.common || '') : (localRow ? localRow.image : '');
    const subjectTags = subject ? subjectTagNames(subject) : (localRow ? parseTags(localRow.subject_tags) : []);
    if (name || nameCn || subjectId) {
      await pool.query(
        `INSERT INTO collections (user_id, subject_id, subject_type, name, name_cn, image, score, status, ep_status, comment, tags, subject_tags, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, subject_id) DO UPDATE SET subject_type = excluded.subject_type, name = excluded.name,
           name_cn = excluded.name_cn, image = excluded.image, score = excluded.score, status = excluded.status,
           ep_status = excluded.ep_status, comment = excluded.comment, tags = excluded.tags, subject_tags = excluded.subject_tags, updated_at = excluded.updated_at`,
        [req.user.id, subjectId, subjectType, name, nameCn, image,
         rate, type, Math.max(0, Math.round(+(epStatus || 0))), comment || '',
         tagsArr.length ? JSON.stringify(tagsArr) : null,
         subjectTags.length ? JSON.stringify(subjectTags) : null, Date.now()]
      );
    }
    res.json({ ok: true, bgmSynced });
  } catch (e) { next(e); }
});

// 删除收藏
router.delete('/collections/:subjectId', async (req, res, next) => {
  try {
    const subjectId = +req.params.subjectId;
    const token = await getValidToken(req.user);
    if (token) {
      try { await bgm(`/v0/users/-/collections/${subjectId}`, { method: 'DELETE', token }); } catch (e) { /* ignore */ }
    }
    await pool.query('DELETE FROM collections WHERE user_id = ? AND subject_id = ?', [req.user.id, subjectId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 从 Bangumi 导入全部收藏到本地（后台异步任务，避免 6000+ 条同步导入导致请求超时）
const importJobs = new Map(); // userId -> { running, done, total, expected, currentType, error, startedAt }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function insertBgmItems(conn, userId, items, subjectType) {
  for (const c of items) {
    const s = c.subject || {};
    await conn.query(
      `INSERT INTO collections (user_id, subject_id, subject_type, name, name_cn, image, score, status, ep_status, comment, tags, subject_tags, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, subject_id) DO UPDATE SET subject_type = excluded.subject_type, name = excluded.name,
         name_cn = excluded.name_cn, image = excluded.image, score = excluded.score, status = excluded.status,
         ep_status = excluded.ep_status, comment = excluded.comment, tags = excluded.tags, subject_tags = excluded.subject_tags, updated_at = excluded.updated_at`,
      [userId, c.subject_id, s.type || c.subject_type || subjectType, s.name || '', s.name_cn || '',
       (s.images && s.images.common) || '', c.rate || 0, c.type || 0, c.ep_status || 0,
       c.comment || '', c.tags ? JSON.stringify(c.tags) : null,
       subjectTagNames(s).length ? JSON.stringify(subjectTagNames(s)) : null, Date.now()]
    );
  }
}

// 后台导入任务：按类型分页拉取并写入本地表（upsert，可重复执行）
async function runBgmImport(userId, bangumiUid, token) {
  const job = importJobs.get(userId);
  const types = [1, 2, 3, 4, 6];
  try {
    for (const subjectType of types) {
      job.currentType = subjectType;
      const conn = await pool.getConnection();
      try {
        let offset = 0;
        let first = true;
        for (;;) {
          const data = await fetchBgmCollections(bangumiUid, token, { subjectType, limit: 50, offset });
          const items = data.data || [];
          if (first) { job.expected += (data.total || 0); first = false; }
          await insertBgmItems(conn, userId, items, subjectType);
          job.done += items.length;
          offset += items.length;
          if (items.length >= 50 && (data.total == null || offset < data.total)) {
            await sleep(120); // 每页稍微间隔，避免打爆 Bangumi 限流
            continue;
          }
          break;
        }
      } finally {
        conn.release();
      }
    }
    job.total = job.done;
  } catch (e) {
    job.error = e.message || '导入失败';
    console.error('[collections] import job failed for user', userId, ':', e.message);
  }
  job.running = false;
}

// 触发导入：立即返回，后台执行
router.post('/collections/import', async (req, res, next) => {
  try {
    const token = await getValidToken(req.user);
    if (!token) return res.status(400).json({ error: 'Bangumi 未连接' });
    const existing = importJobs.get(req.user.id);
    if (existing && existing.running) return res.json({ ok: false, reason: 'already running' });
    importJobs.set(req.user.id, {
      running: true, done: 0, total: 0, expected: 0, currentType: 0, error: '', startedAt: Date.now()
    });
    runBgmImport(req.user.id, req.user.bangumi_uid, token); // 不 await，后台跑
    res.json({ ok: true, running: true });
  } catch (e) { next(e); }
});

// 导入进度查询（前端轮询）
router.get('/collections/import/status', (req, res) => {
  const job = importJobs.get(req.user.id);
  if (!job) return res.json({ running: false, done: 0, total: 0, expected: 0, currentType: 0, error: '' });
  res.json(job);
});

// 将本地收藏推送到 Bangumi（反向同步）
router.post('/collections/export', async (req, res, next) => {
  try {
    const token = await getValidToken(req.user);
    if (!token) return res.status(400).json({ error: 'Bangumi 未连接' });
    const [rows] = await pool.query('SELECT * FROM collections WHERE user_id = ?', [req.user.id]);
    let pushed = 0;
    for (const c of rows) {
      try {
        const body = {
          type: Math.min(Math.max(+(c.status || 1), 1), 5),
          rate: Math.min(Math.max(Math.round(+(c.score || 0)), 0), 10),
          comment: c.comment || '',
          tags: (() => {
            try { const a = JSON.parse(c.tags || '[]'); return Array.isArray(a) ? a.slice(0, 20).map(String) : []; }
            catch (e) { return []; }
          })()
        };
        if (+c.subject_type === 1) body.ep_status = Math.max(0, Math.round(+(c.ep_status || 0)));
        await bgm(`/v0/users/-/collections/${c.subject_id}`, { method: 'PATCH', token, body });
        pushed++;
      } catch (e) { /* skip failed */ }
    }
    res.json({ ok: true, pushed });
  } catch (e) { next(e); }
});

// 单个条目的收藏状态（本地优先，可回源 Bangumi）
router.get('/me/collections/:subjectId', async (req, res, next) => {
  try {
    const subjectId = +req.params.subjectId;
    if (!subjectId) return res.json({ collection: null });
    const [rows] = await pool.query('SELECT * FROM collections WHERE user_id = ? AND subject_id = ?', [req.user.id, subjectId]);
    if (rows.length) {
      const r = { ...rows[0], tags: parseTags(rows[0].tags) };
      return res.json({ source: 'local', collection: r });
    }
    const token = await getValidToken(req.user);
    if (token) {
      try {
        const data = await bgm(`/v0/users/-/collections/${subjectId}`, { token });
        return res.json({ source: 'bangumi', collection: data });
      } catch (e) { /* not collected or error */ }
    }
    res.json({ collection: null });
  } catch (e) { next(e); }
});

module.exports = router;
