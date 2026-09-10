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

// Bangumi v0 API：POST /users/-/collections/{sid} 不存在则创建、存在则更新（type/rate/comment/tags）。
// 动画的观看进度不能直接写进收藏的 ep_status（那只表示已看「本篇集数」），必须逐集标记，
// Bangumi 会自动重算该动画的观看进度。这里做的是双向 diff：目标进度 = 本地 sort 口径（到第 N 话为止），
// 已看集 = sort <= target 的本篇集。降低目标时会把超出的已看集取消（type=0），
// 因此「倒回进度 / 取消看过」在网站上改完也能原样同步到 Bangumi。
async function syncBgmCollection(token, subjectId, subjectType, { type, rate, comment, tags, epStatus } = {}) {
  const body = {
    type: Math.min(Math.max(+(type || 1), 1), 5),
    rate: Math.min(Math.max(Math.round(+(rate || 0)), 0), 10)
  };
  if (comment != null) body.comment = String(comment).slice(0, 1000);
  if (tags != null) body.tags = Array.isArray(tags) ? tags.slice(0, 20).map(String) : [];
  const isBook = +subjectType === 1;
  if (isBook && epStatus != null) body.ep_status = Math.max(0, Math.round(+(epStatus || 0)));
  // 先确保收藏本体存在（创建或更新），书籍的卷数进度直接写在收藏里，动画随后 diff 剧集观看状态
  await bgm(`/v0/users/-/collections/${subjectId}`, { method: 'POST', token, body });
  if (!isBook && epStatus != null) {
    await diffBgmEpisodes(token, subjectId, Math.max(0, Math.round(+(epStatus || 0))));
  }
}

// 拉取条目全部本篇剧集（type 为 0/空，sort 升序），返回 [{ id, sort }]
async function fetchMainEpisodes(token, subjectId) {
  const eps = [];
  let offset = 0;
  for (let safety = 0; safety < 50; safety++) { // 防御异常条目：最多拉 5000 集
    const data = await bgm(`/v0/episodes?subject_id=${subjectId}&offset=${offset}&limit=100`, { token });
    const list = (data && data.data) || [];
    for (const ep of list) {
      if (ep && ep.id && +ep.sort > 0 && (ep.type == null || +ep.type === 0)) {
        eps.push({ id: ep.id, sort: +ep.sort });
      }
    }
    offset += list.length;
    if (!list.length || offset >= ((data && data.total != null) ? +data.total : offset)) break;
    await sleep(120); // 多页稍作间隔，避免打爆 Bangumi 限流
  }
  eps.sort((a, b) => a.sort - b.sort);
  return eps;
}

// 取条目「本篇剧集」的排序号数组（升序、去重）：优先命中本地 cache 表（/v0/episodes 分页缓存），
// 缺页时才请求 Bangumi 并回填，导入时不必为每个条目反复刷完整集列表。
async function fetchMainEpSortsCached(token, subjectId) {
  const sorts = [];
  const seen = new Set();
  let offset = 0;
  for (let safety = 0; safety < 60; safety++) {
    const key = `bgm:episodes:${subjectId}:${offset}:100`;
    const data = await cached(key, 24 * 3600 * 1000, () =>
      bgm(`/v0/episodes?subject_id=${subjectId}&offset=${offset}&limit=100`, { token }));
    const list = (data && data.data) || [];
    for (const ep of list) {
      if (ep && ep.id && +ep.sort > 0 && (ep.type == null || +ep.type === 0)) {
        const s = +ep.sort;
        if (!seen.has(s)) { seen.add(s); sorts.push(s); }
      }
    }
    offset += list.length;
    const total = data && data.total != null ? +data.total : offset;
    if (!list.length || offset >= total) break;
    await sleep(120);
  }
  sorts.sort((a, b) => a - b);
  return sorts;
}

// Bangumi 收藏里的 ep_status 是「已看本篇集数」（从 1 起计数），而本站本地 ep_status 是
// 「看到第几话」（本篇剧集 sort，跨季条目可能是 78..85 而不是 1..8），两者口径不同，
// 导入时不能直接回写。书籍(subjectType=1)没有逐集 sort 概念，ep_status 本身就是进度，原样返回；
// 其余类型把第 count 个本篇剧集的 sort 换算成本地进度；无法换算（拉取失败/无本篇剧集）时返回 null，由调用方兜底。
async function bgmEpCountToLocalSort(token, subjectId, subjectType, bgmEpStatus) {
  const count = Math.max(0, Math.round(+(bgmEpStatus || 0)));
  if (!count || +subjectType === 1) return count;
  let sorts = [];
  try {
    sorts = await fetchMainEpSortsCached(token, subjectId);
  } catch (e) {
    console.error('[collections] fetch episode sorts failed for subject', subjectId, ':', (e && e.message) || e);
    return null;
  }
  if (!sorts.length) return null;
  return sorts[Math.min(count, sorts.length) - 1];
}

// 当前用户该条目的逐集观看状态：episode.id -> type（2=看过，其余按未看处理）
// 必须分页：该接口默认 limit=100（如银魂 201 集只返回前 100 集），只读第一页会导致
// 后半段已看集读不到，倒回进度/取消看过时漏掉这些集（表现为「进度回退无效」）。
async function fetchEpisodeStates(token, subjectId) {
  const map = new Map();
  let offset = 0;
  for (let safety = 0; safety < 100; safety++) { // 防御异常条目：最多 100 页（10000 集）
    const data = await bgm(`/v0/users/-/collections/${subjectId}/episodes?limit=100&offset=${offset}`, { token });
    const list = (data && data.data) || [];
    for (const it of list) {
      if (it && it.episode && it.episode.id) map.set(it.episode.id, +it.type || 0);
    }
    offset += list.length;
    if (!list.length || offset >= ((data && data.total != null) ? +data.total : offset)) break;
    await sleep(120); // 多页稍作间隔，避免触发 Bangumi 限流
  }
  return map;
}

// 逐集 PATCH（按 50 个分块避免单次请求体过大）；type=2 看过 / type=0 取消看过
async function patchBgmEpisodes(token, subjectId, episodeIds, type) {
  if (!episodeIds || !episodeIds.length) return;
  const CHUNK = 50;
  for (let i = 0; i < episodeIds.length; i += CHUNK) {
    await bgm(`/v0/users/-/collections/${subjectId}/episodes`, {
      method: 'PATCH', token,
      body: { episode_id: episodeIds.slice(i, i + CHUNK), type }
    });
    await sleep(150);
  }
}

// 把本地进度（sort 口径）换算成 BGM 逐集状态：目标 sort 及之前的标为看过，
// 目标之后的已看集取消看过（支持倒回/取消看过，而不是只增不减）。
async function diffBgmEpisodes(token, subjectId, target) {
  const eps = await fetchMainEpisodes(token, subjectId);
  if (!eps.length) return; // 无本篇剧集（音乐/游戏/三次元等）无需处理
  const cur = await fetchEpisodeStates(token, subjectId);
  const toWatch = [];
  const toUnwatch = [];
  for (const e of eps) {
    const watched = cur.get(e.id) === 2;
    if (e.sort <= target) { if (!watched) toWatch.push(e.id); }
    else if (watched) toUnwatch.push(e.id);
  }
  await patchBgmEpisodes(token, subjectId, toWatch, 2);
  await patchBgmEpisodes(token, subjectId, toUnwatch, 0);
}

// 设置收藏状态（先写 Bangumi 再落本地）
// 本地始终保留一份（防止 Bangumi 挂掉时网站改动丢失）；BGM 写入失败时本地照常保存并标记
// sync_dirty=1 + sync_error，等下一次导入/自动同步自动补推，前端会收到 pending 提示。
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
    {
      const [rows] = await pool.query('SELECT * FROM collections WHERE user_id = ? AND subject_id = ?', [req.user.id, subjectId]);
      localRow = rows[0] || null;
      if (localRow && !subject) subjectType = +localRow.subject_type || subjectType;
    }
    // Bangumi v0 API 约束：type 1-5（5=抛弃，不提供 0/删除）、rate 0-10 整数
    const type = Math.min(Math.max(+(status || 1), 1), 5);
    const rate = Math.min(Math.max(Math.round(+(score || 0)), 0), 10);
    // 未显式传进度时沿用本地已有进度（只改状态/评分/评论不应清空观看进度）
    const ep = epStatus != null ? Math.max(0, Math.round(+(epStatus || 0))) : (localRow ? +localRow.ep_status || 0 : 0);
    // tags 未显式传入（undefined）时沿用本地已有标签：点击剧集只改进度，不能顺手把本地标签清空。
    // 只有显式传数组时才覆盖（空数组=清空），与 Bangumi 侧「不传就不动」的行为保持一致。
    const tagsArr = Array.isArray(tags) ? tags.slice(0, 20).map(String) : parseTags(localRow && localRow.tags);
    const name = subject ? (subject.name || '') : (localRow ? localRow.name : '');
    const nameCn = subject ? (subject.name_cn || '') : (localRow ? localRow.name_cn : '');
    const image = subject && subject.images ? (subject.images.common || '') : (localRow ? localRow.image : '');
    const subjectTags = subject ? subjectTagNames(subject) : (localRow ? parseTags(localRow.subject_tags) : []);
    const now = Date.now();
    let bgmSynced = false;
    let syncError = null;
    // 1) 推送 Bangumi（逐集 diff：sort<=进度标看过，超出的已看集取消，支持倒回/取消看过）
    if (token) {
      try {
        await syncBgmCollection(token, subjectId, subjectType, {
          type, rate,
          ...(comment != null ? { comment } : {}),
          ...(tags != null ? { tags } : {}),
          ...(epStatus != null ? { epStatus: ep } : {})
        });
        bgmSynced = true;
      } catch (e) {
        syncError = String((e && e.message) || e || 'Bangumi 同步失败').slice(0, 500);
      }
    } else {
      syncError = 'Bangumi 未连接，改动已保存在本站，将在同步时自动重试';
    }
    // 2) 本地照常保存：成功清 dirty；失败标 dirty（保留旧 synced_at）等待下次导入/自动同步补推
    const syncedAt = bgmSynced ? now : (localRow ? +localRow.synced_at || 0 : 0);
    if (name || nameCn || subjectId) {
      await pool.query(
        `INSERT INTO collections (user_id, subject_id, subject_type, name, name_cn, image, score, status, ep_status, comment, tags, subject_tags, updated_at, synced_at, sync_dirty, sync_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, subject_id) DO UPDATE SET subject_type = excluded.subject_type, name = excluded.name,
           name_cn = excluded.name_cn, image = excluded.image, score = excluded.score, status = excluded.status,
           ep_status = excluded.ep_status, comment = excluded.comment, tags = excluded.tags, subject_tags = excluded.subject_tags,
           updated_at = excluded.updated_at, synced_at = excluded.synced_at, sync_dirty = excluded.sync_dirty, sync_error = excluded.sync_error`,
        [req.user.id, subjectId, subjectType, name, nameCn, image, rate, type, ep, comment || '',
         tagsArr.length ? JSON.stringify(tagsArr) : null,
         subjectTags.length ? JSON.stringify(subjectTags) : null, now, syncedAt, bgmSynced ? 0 : 1, bgmSynced ? null : syncError]
      );
    }
    if (bgmSynced) res.json({ ok: true, bgmSynced: true, pending: false });
    else res.json({ ok: true, bgmSynced: false, pending: true, error: syncError });
  } catch (e) { next(e); }
});

// 从 Bangumi 导入收藏到本地：全局队列（同一时刻只跑 1 个任务）+ 每用户冷却，
// 避免并发任务把 Bangumi API 与本地 1 核小机打爆；普通用户无法绕过队列无限请求
const config = require('../config');
const importJobs = new Map(); // userId -> 内存进度（仅 /collections/import/status 展示用；排队状态以 DB 表为准）
const importQueue = [];       // 全局等待队列（FIFO）：同一时刻只出队执行一个任务
let queueRunner = null;       // 队列 worker 单例
let recoveryStarted = false;  // 崩溃恢复只执行一次（DB 就绪后由 server.js 调用）
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function setMemoryJob(userId, kind, queued) {
  importJobs.set(userId, {
    kind, running: false, queued, done: 0, total: 0, expected: 0, currentType: 0, pruned: 0,
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

// 入队校验与登记（纯逻辑，不写 HTTP）：已运行/已排队 -> 拒绝；冷却期内 -> 限流；
// 否则写入 DB 后再入内存队列并启动 worker。返回 { ok, queued, reason?, error?, retryAfterSec? }
async function enqueueSyncCore(userId, kind) {
  const existing = importJobs.get(userId);
  if (existing && (existing.running || existing.queued)) {
    return { ok: false, reason: 'already queued', error: '已有同步任务在排队，请等待完成后再试' };
  }
  const row = await dbSyncRow(userId);
  if (row && (row.status === 'queued' || row.status === 'running')) {
    // 内存状态丢失（如进程重启）但 DB 仍有未完成任务：覆盖重建内存任务后重新入队继续执行
    setMemoryJob(userId, row.kind || kind, true);
    importQueue.push({ userId });
    startQueueWorker();
    return { ok: true, queued: true };
  }
  const remain = await cooldownRemainMs(userId);
  if (remain > 0) {
    return { ok: false, reason: 'rate-limited', error: '同步操作太频繁，请稍后再试', retryAfterSec: Math.ceil(remain / 1000) };
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
  // 覆盖旧的内存任务：即使上一次已完成（内存里残留 running=false/queued=false 的旧任务），
  // 也必须重置为 queued=true，否则队列 worker 会把它当无效任务跳过，导致同一次进程生命周期里
  // 第二次及以后的同步被静默丢弃（自动同步也会因此只生效一次）
  setMemoryJob(userId, kind, true);
  importQueue.push({ userId });
  startQueueWorker();
  return { ok: true, queued: true };
}

// 触发同步的 HTTP 入口（保持对外行为不变：已排队/其他失败返回 JSON，冷却期内 429）
async function enqueueSync(userId, kind, res) {
  const result = await enqueueSyncCore(userId, kind);
  if (!result.ok && result.reason === 'rate-limited') {
    return res.status(429).json(result);
  }
  res.json(result);
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
      setMemoryJob(r.user_id, r.kind || 'import', true);
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
        } else {
          // 网站侧收藏/进度的修改已实时推送到 Bangumi（见 PUT /collections/:subjectId），
          // 这里的队列只负责「BGM -> 本地」导入 + 开头对待重推(dirty)条目的补推。
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
async function insertBgmItems(conn, userId, items, subjectType, token) {
  // 导入是「BGM -> 本地」的拉取方向：本地存在待重推(sync_dirty=1)的条目要跳过，
  // 避免用 Bangumi 的旧数据覆盖用户刚改完、还没推成功的本地修改（runBgmImport 开头会先补推它们）。
  const [dirty] = await conn.query('SELECT subject_id FROM collections WHERE user_id = ? AND sync_dirty = 1', [userId]);
  const dirtyIds = new Set((dirty || []).map(r => r.subject_id));
  const [existRows] = await conn.query('SELECT subject_id, ep_status FROM collections WHERE user_id = ?', [userId]);
  const existEp = new Map((existRows || []).map(r => [r.subject_id, +r.ep_status || 0]));
  for (const c of items) {
    if (dirtyIds.has(c.subject_id)) continue;
    const s = c.subject || {};
    const subjectTypeOf = +(s.type || c.subject_type || subjectType) || 2;
    const bgmEp = Math.max(0, Math.round(+(c.ep_status || 0)));
    let epLocal = bgmEp;
    // 按集计进度的类型（动画/三次元等）：BGM 的 ep_status 是「已看本篇集数」，本站 ep_status 是
    // 「看到第几话」（本篇剧集 sort，跨季条目可能是 78..85），直接回写会把进度覆盖错；
    // 换算失败时保留本地原值（没有本地记录则置 0），不写坏数据。
    if (bgmEp > 0 && subjectTypeOf !== 1) {
      const mapped = await bgmEpCountToLocalSort(token, c.subject_id, subjectTypeOf, bgmEp);
      epLocal = mapped != null ? mapped : (existEp.has(c.subject_id) ? existEp.get(c.subject_id) : 0);
      await sleep(60); // 每个条目稍作间隔，避免瞬时请求过多
    }
    const now = Date.now();
    await conn.query(
      `INSERT INTO collections (user_id, subject_id, subject_type, name, name_cn, image, score, status, ep_status, comment, tags, subject_tags, updated_at, synced_at, sync_dirty, sync_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
       ON CONFLICT(user_id, subject_id) DO UPDATE SET subject_type = excluded.subject_type, name = excluded.name,
         name_cn = excluded.name_cn, image = excluded.image, score = excluded.score, status = excluded.status,
         ep_status = excluded.ep_status, comment = excluded.comment, tags = excluded.tags, subject_tags = excluded.subject_tags,
         updated_at = excluded.updated_at, synced_at = excluded.synced_at, sync_dirty = 0, sync_error = NULL`,
      [userId, c.subject_id, subjectTypeOf, s.name || '', s.name_cn || '',
       (s.images && s.images.common) || '', c.rate || 0, c.type || 0, epLocal,
       c.comment || '', c.tags ? JSON.stringify(c.tags) : null,
       subjectTagNames(s).length ? JSON.stringify(subjectTagNames(s)) : null, now, now]
    );
  }
}

// Bangumi 侧删除了收藏时本地也要跟着删：否则「全部」Tab 计数、导出备份里会留下
// Bangumi 上已经不存在的「幽灵条目」（表现为计数比列表多、导出比列表多）。
// 只清理 sync_dirty=0 的行：本地改动还没推成功（dirty）的条目必须保留，等下次补推。
// 另外必须用「导入开始时的快照」二次确认（snapshot: subject_id -> updated_at）：
// 导入期间用户新增/修改的收藏（PUT 已写回 Bangumi，但不在本轮已拉过的分页里）不在 seenIds 中，
// 若不比对快照就会被当成「Bangumi 侧已删除」而误删。
async function pruneDeletedOnBgm(userId, seenIds, snapshot) {
  if (!snapshot || !snapshot.size) return 0;
  const candidates = [];
  for (const id of snapshot.keys()) {
    if (!seenIds.has(id)) candidates.push(id);
  }
  if (!candidates.length) return 0;
  let deleted = 0;
  for (let i = 0; i < candidates.length; i += 200) {
    const chunk = candidates.slice(i, i + 200);
    const ph = chunk.map(() => "?").join(",");
    const [rows] = await pool.query(
      `SELECT subject_id, updated_at FROM collections WHERE user_id = ? AND COALESCE(sync_dirty, 0) = 0 AND subject_id IN (${ph})`,
      [userId, ...chunk]
    );
    // 只删「快照里就在、至今没被改过、仍未推脏」的行；updated_at 变了说明期间有用户操作，必须保留
    const doomed = (rows || [])
      .filter(r => +r.updated_at === snapshot.get(+r.subject_id))
      .map(r => +r.subject_id);
    if (!doomed.length) continue;
    const [r] = await pool.query(
      `DELETE FROM collections WHERE user_id = ? AND COALESCE(sync_dirty, 0) = 0 AND subject_id IN (${doomed.map(() => "?").join(",")})`,
      [userId, ...doomed]
    );
    deleted += (r && r.affectedRows) || 0;
  }
  if (deleted) console.log('[collections] pruned', deleted, 'local collection(s) no longer on Bangumi for user', userId);
  return deleted;
}

// 导入/自动同步开始前，先把本地待重推(sync_dirty=1)的收藏补推给 Bangumi：
// 单条失败不中断（保留 dirty，等下次同步再试）；成功后清 dirty，随后导入回写时
// Bangumi 上已是用户的最新改动，本地不会被旧数据覆盖。
async function pushDirtyLocal(userId, token) {
  const [rows] = await pool.query('SELECT * FROM collections WHERE user_id = ? AND sync_dirty = 1', [userId]);
  for (const c of rows) {
    try {
      const tags = (() => {
        try { const a = JSON.parse(c.tags || '[]'); return Array.isArray(a) ? a.slice(0, 20).map(String) : []; }
        catch (e) { return []; }
      })();
      await syncBgmCollection(token, c.subject_id, +c.subject_type || 2, {
        type: Math.min(Math.max(+(c.status || 1), 1), 5),
        rate: Math.min(Math.max(Math.round(+(c.score || 0)), 0), 10),
        comment: c.comment || '',
        tags,
        epStatus: Math.max(0, Math.round(+(c.ep_status || 0)))
      });
      await pool.query(
        'UPDATE collections SET sync_dirty = 0, sync_error = NULL, synced_at = ? WHERE user_id = ? AND subject_id = ?',
        [Date.now(), userId, c.subject_id]
      );
    } catch (e) {
      // 保留 sync_dirty=1：本次仍失败，等下次导入/自动同步再试
      console.error('[collections] push pending change failed for user', userId, 'subject', c.subject_id, ':', (e && e.message) || e);
    }
    await sleep(120); // 逐条稍作间隔，避免触发 Bangumi 限流
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
  // 导入前先给「本地已同步」的行拍快照（subject_id -> updated_at）：清理阶段只删快照里存在、
  // 且期间没被用户改动过的行，避免把导入期间新增/修改的收藏误删（见 pruneDeletedOnBgm）。
  const pruneSnapshot = new Map();
  try {
    const [snapRows] = await pool.query(
      'SELECT subject_id, updated_at FROM collections WHERE user_id = ? AND COALESCE(sync_dirty, 0) = 0',
      [userId]
    );
    for (const r of snapRows || []) pruneSnapshot.set(+r.subject_id, +r.updated_at || 0);
  } catch (e) {
    console.error('[collections] prune snapshot failed for user', userId, ':', e.message);
  }
  // 先补推本地待重推(pending)的改动：成功后清 dirty；仍失败保留 dirty，下方导入会跳过这些条目，
  // 避免用 Bangumi 的旧数据覆盖用户刚改完、还没推成功的本地修改。
  try {
    await pushDirtyLocal(userId, token);
  } catch (e) {
    console.error('[collections] push pending changes failed for user', userId, ':', e.message);
  }
  const bangumiUid = user.bangumi_uid;
  const types = [1, 2, 3, 4, 6];
  const seenIds = new Set(); // 本次从 Bangumi 实际拉到的 subject_id（用于对齐删除）
  let complete = true;       // 任何一页提前结束都置 false：结果不完整时不做删除，避免误删
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
          const pgTotal = data.total != null ? +data.total : null;
          if (first) { job.expected += (data.total || 0); first = false; }
          await insertBgmItems(conn, userId, items, subjectType, token);
          for (const it of items) if (it && it.subject_id != null) seenIds.add(+it.subject_id);
          job.done += items.length;
          offset += items.length;
          if (items.length >= 50 && (pgTotal == null || offset < pgTotal)) {
            await sleep(120); // 每页稍微间隔，避免打爆 Bangumi 限流
            continue;
          }
          if (pgTotal != null && offset < pgTotal) complete = false; // 分页提前结束 → 本轮不作为删除依据
          break;
        }
      } finally {
        conn.release();
      }
    }
    // Bangumi 是收藏「存在性」的权威源：BGM 侧取消收藏后，本地同步删除（见 pruneDeletedOnBgm）
    job.pruned = complete ? await pruneDeletedOnBgm(userId, seenIds, pruneSnapshot) : 0;
    job.total = job.done;
  } catch (e) {
    job.error = e.message || '导入失败';
    console.error('[collections] import job failed for user', userId, ':', e.message);
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
  const base = job || { running: false, queued: false, done: 0, total: 0, expected: 0, currentType: 0, pruned: 0, error: '' };
  res.json({ ...base, autoSync: getAutoSyncInfo() });
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
        // 单条收藏读取需用本人 uid 路径：/users/-/collections/{sid} 只对写入类接口有效，
        // 对 subject_type=2（动画）等条目读取会 404。返回体归一化为与本地收藏同构，方便前端直接使用。
        const uid = req.user.bangumi_uid;
        const path = uid ? `/v0/users/${uid}/collections/${subjectId}` : `/v0/users/-/collections/${subjectId}`;
        const data = await bgm(path, { token });
        if (data && data.subject_id != null) {
          const s = data.subject || {};
          const subjectTypeOf = +(s.type || data.subject_type) || 2;
          // BGM 单条收藏的 ep_status 是「已看本篇集数」计数，浏览时也换算成站点 sort 口径显示
          let epStatus = data.ep_status || 0;
          if (epStatus > 0 && subjectTypeOf !== 1) {
            const mapped = await bgmEpCountToLocalSort(token, subjectId, subjectTypeOf, epStatus);
            if (mapped != null) epStatus = mapped;
          }
          return res.json({
            source: 'bangumi',
            collection: {
              ...s, ...data,
              id: data.subject_id,
              subject_id: data.subject_id,
              subject_type: s.type || data.subject_type || 2,
              type: s.type || data.subject_type || 2,
              status: data.type,
              score: data.rate || 0,
              ep_status: epStatus,
              comment: data.comment || '',
              name: s.name || data.name || '',
              name_cn: s.name_cn || data.name_cn || '',
              images: s.images || null,
              tags: data.tags || [],
              subject_tags: subjectTagNames(s)
            }
          });
        }
      } catch (e) { /* not collected or error */ }
    }
    res.json({ collection: null });
  } catch (e) { next(e); }
});

// ---------- 追番收藏「自动同步」----------
// 服务端定时把已连接 Bangumi 的用户的收藏拉回本地（只导入、不导出），避免每次手动点导入。
// 与手动导入共用同一全局串行队列 + 每用户冷却，不会打爆 Bangumi API / 本地 1 核小机。
const AUTO_SYNC_INTERVAL_MS = Math.max(config.bgmAutoImportIntervalMs || 0, 0);
const AUTO_SYNC_FIRST_DELAY_MS = 30 * 1000; // 进程启动 30 秒后先自动同步一次
const AUTO_SYNC_MAX_JOBS = 3;               // 每轮最多入队几个用户（串行逐个执行，避免一次堆积太多）
let autoSyncStarted = false;   // 定时器只启动一次
let autoSyncRunning = false;   // 正在扫描（防止上一轮没结束、下一轮重叠）
let autoSyncLastRunAt = 0;     // 最近一次扫描开始时间（ms）
let autoSyncNextRunAt = 0;     // 预计下次扫描时间（ms）
let autoSyncLastResult = null; // 最近一次扫描结果 { users, enqueued, skipped }

function getAutoSyncInfo() {
  return {
    enabled: autoSyncStarted && AUTO_SYNC_INTERVAL_MS > 0,
    intervalMs: AUTO_SYNC_INTERVAL_MS,
    running: autoSyncRunning,
    lastRunAt: autoSyncLastRunAt || 0,
    nextRunAt: autoSyncNextRunAt || 0,
    lastResult: autoSyncLastResult
  };
}

// 自动同步一轮：给所有已连接 Bangumi（有 token / refresh_token）的用户补拉收藏
async function autoImportOnce() {
  if (autoSyncRunning || AUTO_SYNC_INTERVAL_MS <= 0) return;
  autoSyncRunning = true;
  const startedAt = Date.now();
  const result = { users: 0, enqueued: 0, skipped: 0 };
  try {
    const [rows] = await pool.query(
      // 按「最久没同步」排序：每轮只入队 AUTO_SYNC_MAX_JOBS 个用户，若按 id 排序，
      // 用户数超过上限时后面的用户永远排不上（会被前面的用户每轮抢占）。
      `SELECT id FROM users
       WHERE bangumi_uid IS NOT NULL
         AND (access_token IS NOT NULL AND access_token <> '' OR refresh_token IS NOT NULL AND refresh_token <> '')
       ORDER BY COALESCE(last_collection_sync_at, 0) ASC, id ASC`
    );
    result.users = rows.length;
    for (const u of rows) {
      if (result.enqueued >= AUTO_SYNC_MAX_JOBS) break;
      const job = importJobs.get(u.id);
      if (job && (job.running || job.queued)) { result.skipped++; continue; }
      // 冷却期内说明刚手动/自动同步过，留给下一轮再拉
      const remain = await cooldownRemainMs(u.id);
      if (remain > 0) { result.skipped++; continue; }
      const r = await enqueueSyncCore(u.id, 'import');
      if (r && r.ok) result.enqueued++;
      else result.skipped++;
    }
  } catch (e) {
    console.error('[collections] auto sync scan failed:', e.message);
  } finally {
    autoSyncLastRunAt = Date.now();
    autoSyncNextRunAt = autoSyncLastRunAt + AUTO_SYNC_INTERVAL_MS;
    autoSyncLastResult = result;
    autoSyncRunning = false;
    console.log('[collections] auto sync scan done:', JSON.stringify(result));
  }
}

// 启动自动同步定时器（server.js 在 DB 就绪、同步队列恢复后调用）
function startAutoImportScheduler() {
  if (autoSyncStarted) return;
  autoSyncStarted = true;
  if (AUTO_SYNC_INTERVAL_MS <= 0) {
    console.log('[collections] auto sync disabled (bgmAutoImportIntervalMs=0)');
    return;
  }
  autoSyncNextRunAt = Date.now() + AUTO_SYNC_FIRST_DELAY_MS;
  setTimeout(() => { autoImportOnce().catch(() => {}); }, AUTO_SYNC_FIRST_DELAY_MS);
  setInterval(() => { autoImportOnce().catch(() => {}); }, AUTO_SYNC_INTERVAL_MS);
  console.log('[collections] auto sync scheduler started, interval=' + (AUTO_SYNC_INTERVAL_MS / 3600000).toFixed(1) + 'h');
}

module.exports = router;
// 供 server.js 在 DB 就绪后调用：恢复上次进程中断的同步任务（重启不丢任务）
router.initSyncQueue = recoverPendingSyncs;
// 供 server.js 在 DB 就绪后调用：启动追番收藏自动同步定时器
router.startAutoImportScheduler = startAutoImportScheduler;
// 自动同步状态查询（/collections/import/status 已附带该信息）
router.getAutoSyncInfo = getAutoSyncInfo;
