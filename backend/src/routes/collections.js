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

// 从 Bangumi 导入/导出收藏到本地：全局队列（同一时刻只跑 1 个任务）+ 每用户冷却，
// 避免并发任务把 Bangumi API 与本地 1 核小机打爆；普通用户无法绕过队列无限请求
const config = require('../config');
const importJobs = new Map(); // userId -> 内存进度（仅 /collections/import/status 展示用；排队状态以 DB 表为准）
const importQueue = [];       // 全局等待队列（FIFO）：同一时刻只出队执行一个任务
let queueRunner = null;       // 队列 worker 单例
let recoveryStarted = false;  // 崩溃恢复只执行一次（DB 就绪后由 server.js 调用）
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function setMemoryJob(userId, kind, queued) {
  importJobs.set(userId, {
    kind, running: false, queued, done: 0, total: 0, expected: 0, currentType: 0,
    error: '', startedAt: Date.now()
  });
}

async function dbSyncRow(userId) {
  const [rows] = await pool.query('SELECT * FROM collection_sync_requests WHERE user_id = ?', [userId]);
  return rows[0] || null;
}

// 返回该用户剩余冷却毫秒数（0 表示可发起新同步）；计时基于持久化的最近一次同步时间
async function cooldownRemainMs(userId) {
  const [rows] = await pool.query('SELECT last_collection_sync_at FROM users WHERE id = ?', [userId]);
  const last = +(rows[0] && rows[0].last_collection_sync_at) || 0;
  const remain = last + config.bgmSyncCooldownMs - Date.now();
  return remain > 0 ? remain : 0;
}

// 入队校验与登记：已运行/已排队 -> 拒绝；冷却期内 -> 429；否则写入 DB 后再入内存队列
async function enqueueSync(userId, kind, res) {
  const existing = importJobs.get(userId);
  if (existing && (existing.running || existing.queued)) {
    res.json({ ok: false, reason: 'already queued', error: '已有同步任务在排队，请等待完成后再试' });
    return false;
  }
  const row = await dbSyncRow(userId);
  if (row && (row.status === 'queued' || row.status === 'running')) {
    // 内存状态丢失（如进程重启）但 DB 仍有未完成任务：重新入队继续执行
    if (!existing) setMemoryJob(userId, row.kind || kind, true);
    importQueue.push({ userId });
    startQueueWorker();
    res.json({ ok: true, queued: true });
    return true;
  }
  const remain = await cooldownRemainMs(userId);
  if (remain > 0) {
    res.status(429).json({ ok: false, reason: 'rate-limited', error: '同步操作太频繁，请稍后再试', retryAfterSec: Math.ceil(remain / 1000) });
    return false;
  }
  const now = Date.now();
  await pool.query(
    `INSERT INTO collection_sync_requests (user_id, kind, status, error, enqueued_at, started_at, finished_at)
     VALUES (?, ?, 'queued', '', ?, 0, 0)
     ON CONFLICT(user_id) DO UPDATE SET kind = excluded.kind, status = 'queued', error = '', enqueued_at = excluded.enqueued_at, started_at = 0, finished_at = 0`,
    [userId, kind, now]
  );
  // 入队即开始冷却计时（完成时会再刷新为完成时间），避免排队期间反复点击
  await pool.query('UPDATE users SET last_collection_sync_at = ? WHERE id = ?', [now, userId]);
  if (!importJobs.has(userId)) setMemoryJob(userId, kind, true);
  importQueue.push({ userId });
  startQueueWorker();
  res.json({ ok: true, queued: true });
  return true;
}

// 崩溃恢复：把 DB 中 queued/running 的任务重新置为 queued 并入内存队列（running=上次中断）
async function recoverPendingSyncs() {
  if (recoveryStarted) return;
  recoveryStarted = true;
  try {
    const [rows] = await pool.query(
      `SELECT * FROM collection_sync_requests WHERE status IN ('queued', 'running') ORDER BY enqueued_at ASC`
    );
    for (const r of rows) {
      await pool.query(
        `UPDATE collection_sync_requests SET status = 'queued', error = '', started_at = 0, finished_at = 0 WHERE id = ?`,
        [r.id]
      );
      if (!importJobs.has(r.user_id)) setMemoryJob(r.user_id, r.kind || 'import', true);
      importQueue.push({ userId: r.user_id });
    }
    if (rows.length) {
      console.log('[collections] sync queue recovered', rows.length, 'pending job(s)');
      startQueueWorker();
    }
  } catch (e) {
    console.error('[collections] recover pending syncs failed:', e.message);
  }
}

// 全局队列 worker：串行执行，同一时刻整个进程只有一个同步任务在跑
function startQueueWorker() {
  if (queueRunner) return;
  queueRunner = (async () => {
    while (importQueue.length) {
      const { userId } = importQueue.shift();
      const job = importJobs.get(userId);
      if (!job || job.running || !job.queued) continue;
      job.running = true;
      job.queued = false;
      job.startedAt = Date.now();
      try {
        await pool.query(
          `UPDATE collection_sync_requests SET status = 'running', started_at = ?, finished_at = 0 WHERE user_id = ?`,
          [job.startedAt, userId]
        );
        const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
        if (!users.length) {
          job.error = '用户不存在';
        } else if (job.kind === 'export') {
          await runBgmExport(userId, users[0]);
        } else {
          await runBgmImport(userId, users[0]);
        }
      } catch (e) {
        job.error = e.message || '同步失败';
        console.error('[collections] sync job failed for user', userId, ':', e.message);
      } finally {
        job.running = false;
        const finishedAt = Date.now();
        const status = job.error ? 'failed' : 'done';
        try {
          await pool.query(
            `UPDATE collection_sync_requests SET status = ?, error = ?, finished_at = ? WHERE user_id = ?`,
            [status, String(job.error || '').slice(0, 500), finishedAt, userId]
          );
          // 任务真正结束后刷新冷却计时（取完成时间，避免完成前立刻重发）
          await pool.query('UPDATE users SET last_collection_sync_at = ? WHERE id = ?', [finishedAt, userId]);
        } catch (e) {
          console.error('[collections] persist job result failed for user', userId, ':', e.message);
        }
      }
    }
    queueRunner = null;
  })();
}
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

// 后台导入任务：按类型分页拉取并写入本地表（upsert，可重复执行）；token 在真正执行时取最新
async function runBgmImport(userId, user) {
  const job = importJobs.get(userId);
  if (!job) return;
  let token = null;
  try { token = await getValidToken(user); } catch (e) { /* 刷新失败按未连接处理 */ }
  if (!token) {
    job.error = 'Bangumi 未连接或授权已失效';
    return;
  }
  const bangumiUid = user.bangumi_uid;
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
}

// 反向同步：把本地收藏推送到 Bangumi（同样入全局队列串行执行）
async function runBgmExport(userId, user) {
  const job = importJobs.get(userId);
  if (!job) return;
  let token = null;
  try { token = await getValidToken(user); } catch (e) { /* 刷新失败按未连接处理 */ }
  if (!token) {
    job.error = 'Bangumi 未连接或授权已失效';
    return;
  }
  const [rows] = await pool.query('SELECT * FROM collections WHERE user_id = ?', [userId]);
  job.total = rows.length;
  let pushed = 0;
  try {
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
      } catch (e) { /* 单条失败跳过，不中断整体导出 */ }
      job.done = pushed;
    }
  } catch (e) {
    job.error = e.message || '导出失败';
    console.error('[collections] export job failed for user', userId, ':', e.message);
  }
}

// 触发导入：入队后立即返回，由全局队列串行执行
router.post('/collections/import', async (req, res, next) => {
  try {
    const token = await getValidToken(req.user);
    if (!token) return res.status(400).json({ error: 'Bangumi 未连接' });
    await enqueueSync(req.user.id, 'import', res);
  } catch (e) { next(e); }
});

// 导入进度查询（前端轮询：running=true 执行中；queued=true 排队中；两者皆 false 且无 error 即完成）
router.get('/collections/import/status', (req, res) => {
  const job = importJobs.get(req.user.id);
  if (!job) return res.json({ running: false, queued: false, done: 0, total: 0, expected: 0, currentType: 0, error: '' });
  res.json(job);
});

// 将本地收藏推送到 Bangumi（反向同步，同样入队串行执行）
router.post('/collections/export', async (req, res, next) => {
  try {
    const token = await getValidToken(req.user);
    if (!token) return res.status(400).json({ error: 'Bangumi 未连接' });
    await enqueueSync(req.user.id, 'export', res);
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
// 供 server.js 在 DB 就绪后调用：恢复上次进程中断的同步任务（重启不丢任务）
router.initSyncQueue = recoverPendingSyncs;
