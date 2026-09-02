
// updatepusher.js - 「追番新话更新」检测与主动推送
// 流程：
//   detectUpdates()   每轮扫描新入库且已匹配 Bangumi 的 episodes，给收藏该番的用户写入 watch_updates
//   deliverUpdates()  按用户聚合未推送的 watch_updates，通过其配置的渠道（Server酱/TG/Webhook/邮件/Web Push）推送
//   start()           定时驱动（默认 5 分钟一次，独立于 watch 抓取调度，避免耦合）
const { pool, db } = require('./db');
const { getSetting, setSetting } = require('./rssconfig');
const { getUserNotifySettings, sendToUser, hasChannels } = require('./pushchannels');
const logger = require('./logger');

const INTERVAL_MS = 5 * 60 * 1000;   // 5 分钟一轮（watch 抓取 30 分钟一次，足够及时）
const MAX_PUSH_SERIES = 5;           // 单轮每用户最多推送几部番（其余只入未读列表，防轰炸）
const FIRST_RUN_LOOKBACK_DAYS = 7;   // 首次启动只补最近 7 天的更新，避免历史旧话刷屏
const LAST_ID_KEY = 'updatepusher_last_id';

let timer = null;
let lastRunAt = 0;
let lastDetect = 0;
let lastDeliver = 0;
let lastStats = {};

function getStatus() {
  return { module: 'updatepusher', lastRunAt, lastDetect, lastDeliver, lastStats, intervalMs: INTERVAL_MS };
}

// 扫描新入库 episodes -> 写入 watch_updates（幂等：UNIQUE(user_id, episode_id)）
async function detectUpdates() {
  const t0 = Date.now();
  const [srow] = await pool.query('SELECT value FROM settings WHERE key = ?', [LAST_ID_KEY]);
  let lastId = 0;
  try { lastId = srow.length ? parseInt(srow[0].value, 10) || 0 : 0; } catch (e) { lastId = 0; }

  const lookback = lastId > 0 ? 'AND e.created_at >= datetime(\'now\', \'-3 days\')' : 'AND e.created_at >= datetime(\'now\', ?)';
  const args = lastId > 0 ? [lastId] : ['-' + FIRST_RUN_LOOKBACK_DAYS + ' days'];
  const [eps] = await pool.query(
    `SELECT e.id AS episode_id, e.bgm_subject_id AS subject_id, e.series_title,
            e.episode, e.sub_group, e.quality, e.magnet, e.link, e.published_at
     FROM anime_episodes e
     WHERE e.id > ? AND e.bgm_subject_id IS NOT NULL ${lookback}
     ORDER BY e.id ASC`,
    args
  );
  let maxId = lastId;
  let inserted = 0;
  if (eps.length) {
    const stmt2 = db.prepare(`INSERT OR IGNORE INTO watch_updates
      (user_id, episode_id, subject_id, series_title, name_cn, name, episode, sub_group, quality, magnet, link, published_at)
      SELECT c.user_id, ?, c.subject_id, ?, c.name_cn, c.name, ?, ?, ?, ?, ?, ?
      FROM collections c WHERE c.user_id IN (SELECT id FROM users) AND c.subject_id = ? AND c.status IN (1,3)`);
    for (const e of eps) {
      try {
        const r = stmt2.run(e.episode_id, e.series_title, e.episode, e.sub_group, e.quality, e.magnet, e.link, e.published_at, e.subject_id);
        inserted += Number(r.changes || 0);
      } catch (err) { /* 单条失败忽略 */ }
    }
    maxId = Math.max(maxId, eps[eps.length - 1].episode_id);
  }
  await setSetting(LAST_ID_KEY, maxId);
  lastDetect = Date.now();
  lastStats.lastDetect = { at: lastDetect, scanned: eps.length, inserted, maxId, ms: Date.now() - t0 };
  return { scanned: eps.length, inserted, maxId };
}

// 按用户聚合未推送更新，逐部番推送并标记 notified
async function deliverUpdates() {
  const t0 = Date.now();
  const [rows] = await pool.query(
    `SELECT wu.*, u.username, u.nickname
     FROM watch_updates wu JOIN users u ON u.id = wu.user_id
     WHERE wu.notified = 0
     ORDER BY wu.id ASC`
  );
  if (!rows.length) { lastDeliver = Date.now(); return { users: 0, series: 0, pushed: 0 }; }

  // 按用户分组
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }

  let users = 0, series = 0, pushed = 0, skippedNoChannel = 0;
  for (const [userId, updates] of byUser) {
    try {
      const settings = await getUserNotifySettings(userId);
      const markIds = updates.map(u => u.id);
      // 用户关闭了通知：直接标记已处理（未读列表仍保留，前端角标不受影响）
      if (!settings || settings.enabled === 0 || !hasChannels(settings)) {
        await pool.query('UPDATE watch_updates SET notified = 1 WHERE id IN (' + markIds.map(() => '?').join(',') + ')', markIds);
        skippedNoChannel++;
        continue;
      }
      const user = { id: userId, username: updates[0].username, nickname: updates[0].nickname };
      // 按番（subject_id）聚合
      const bySeries = new Map();
      for (const u of updates) {
        if (!bySeries.has(u.subject_id)) bySeries.set(u.subject_id, []);
        bySeries.get(u.subject_id).push(u);
      }
      let pushedSeries = 0;
      for (const [subjectId, list] of bySeries) {
        if (pushedSeries >= MAX_PUSH_SERIES) break;
        pushedSeries++;
        series++;
        const first = list[0];
        const title = first.name_cn || first.name || first.series_title || '追番更新';
        const eps = list.map(x => x.episode).filter(Boolean).slice(0, 5);
        const epsText = eps.length > 3 ? eps.slice(0, 3).join('、') + ' 等 ' + eps.length + ' 话' : eps.join('、');
        const sub = first.sub_group ? '（' + first.sub_group + '）' : '';
        const body = (epsText ? '新话 ' + epsText + ' 已发布' : '有新资源发布') + sub;
        const payload = {
          title: '🔔 ' + title,
          body,
          url: '/watch?my=1&q=' + encodeURIComponent(first.series_title || title)
        };
        const results = await sendToUser(user, settings, payload);
        if (results.some(r => r.ok)) pushed++;
        // 该番所有行标记已通知
        await pool.query('UPDATE watch_updates SET notified = 1 WHERE id IN (' + list.map(() => '?').join(',') + ')', list.map(x => x.id));
      }
      // 超出推送上限的剩余行也标记已处理（避免每轮重扫），未读角标仍可见
      if (pushedSeries < bySeries.size) {
        const rest = [...bySeries.values()].slice(pushedSeries).flat().map(x => x.id);
        if (rest.length) await pool.query('UPDATE watch_updates SET notified = 1 WHERE id IN (' + rest.map(() => '?').join(',') + ')', rest);
      }
      users++;
    } catch (e) {
      logger.error('[updatepusher] deliver user failed', { userId, message: e.message });
    }
  }
  lastDeliver = Date.now();
  lastStats.lastDeliver = { at: lastDeliver, users, series, pushed, skippedNoChannel, ms: Date.now() - t0 };
  return { users, series, pushed };
}

// 跑一轮：检测 + 推送
async function runOnce() {
  try {
    await detectUpdates();
    await deliverUpdates();
    lastRunAt = Date.now();
  } catch (e) {
    logger.error('[updatepusher] run failed', { message: e.message });
    lastStats.lastError = e.message;
  }
}

function start() {
  if (timer) return;
  // 启动 10 秒后先跑一轮（等 watch 首次抓取完成）
  setTimeout(() => { runOnce().catch(() => {}); }, 10 * 1000);
  timer = setInterval(() => { runOnce().catch(() => {}); }, INTERVAL_MS);
}

module.exports = { start, runOnce, detectUpdates, deliverUpdates, getStatus };
