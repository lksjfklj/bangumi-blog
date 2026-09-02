
// routes/extras.js - 追番统计 / 公开分享 / 收藏导出 / 个人资料公开设置 / 放送日历 ICS
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const { bgm, cached } = require('../bangumi');
const config = require('../config');
const router = express.Router();

const STATUS_TEXT = { 1: '想看', 2: '看过', 3: '在看', 4: '搁置', 5: '抛弃' };

function parseTags(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  if (typeof v === 'string') {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (e) { /* fallthrough */ }
    return v.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

// 收藏时间（毫秒）：优先 watched_at（看完时间），回退 updated_at
function colTimeMs(c) {
  const v = +(c.watched_at || 0) || +(c.updated_at || 0);
  return v > 0 ? v : 0;
}

// ---------- 放送日历·收藏进度 ----------
// GET /api/me/calendar-progress  返回 { [subject_id]: { ep_status, status } }（仅动画收藏）
router.get('/me/calendar-progress', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT subject_id, ep_status, status FROM collections WHERE user_id = ? AND subject_type = 2",
      [req.user.id]
    );
    const map = {};
    for (const r of rows) map[r.subject_id] = { ep_status: +r.ep_status || 0, status: +r.status || 0 };
    res.set('Cache-Control', 'no-store');
    res.json(map);
  } catch (e) { next(e); }
});
// ---------- 追番统计页 ----------
// GET /api/collections/stats?year=2026
router.get('/collections/stats', requireAuth, async (req, res, next) => {
  try {
    const uid = req.user.id;
    const year = Math.max(2000, Math.min(2100, +req.query.year || new Date().getFullYear()));
    const [rows] = await pool.query(
      'SELECT * FROM collections WHERE user_id = ? AND subject_type = 2', [uid]
    );

    // 全量概览
    const byStatus = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let scoreSum = 0, scoreN = 0, watched = 0;
    for (const c of rows) {
      byStatus[c.status] = (byStatus[c.status] || 0) + 1;
      if (+c.score > 0) { scoreSum += +c.score; scoreN++; }
      if (+c.status === 2) watched++;
    }

    // 年度：看过且时间落在该年
    const y0 = new Date(year, 0, 1).getTime();
    const y1 = new Date(year + 1, 0, 1).getTime();
    const yearRows = rows.filter(c => {
      if (+c.status !== 2) return false;
      const t = colTimeMs(c);
      return t >= y0 && t < y1;
    });

    const scoreDist = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => ({ score: v, count: 0 }));
    const monthly = {};
    const tagCount = new Map();
    const timeline = [];
    for (const c of yearRows) {
      const sc = Math.round(+c.score || 0);
      if (sc > 0) scoreDist[sc].count++;
      const t = colTimeMs(c);
      if (t) {
        const d = new Date(t);
        const mk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        monthly[mk] = (monthly[mk] || 0) + 1;
        timeline.push({ subject_id: c.subject_id, name: c.name, name_cn: c.name_cn, image: c.image, score: c.score, watched_at: t });
      }
      for (const tg of [...parseTags(c.tags), ...parseTags(c.subject_tags)]) {
        if (tg) tagCount.set(tg, (tagCount.get(tg) || 0) + 1);
      }
    }
    // 标签云排序（频次 > 名称）
    const tags = [...tagCount.entries()].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));

    // 年度月度（空月补 0，1-12 月）
    const monthlyArr = [];
    for (let m = 1; m <= 12; m++) {
      const mk = year + '-' + String(m).padStart(2, '0');
      monthlyArr.push({ month: mk, count: monthly[mk] || 0 });
    }

    res.set('Cache-Control', 'no-store');
    res.json({
      year,
      overview: {
        total: rows.length,
        byStatus,
        watched,
        avgScore: scoreN ? +(scoreSum / scoreN).toFixed(1) : 0,
        rated: scoreN
      },
      yearStats: {
        watched: yearRows.length,
        scoreDist,
        monthly: monthlyArr,
        tags: tags.slice(0, 60),
        timeline: timeline.sort((a, b) => b.watched_at - a.watched_at).slice(0, 24)
      }
    });
  } catch (e) { next(e); }
});

// ---------- 个人资料公开设置 ----------
// PUT /api/profile/public  { profile_public?: bool, bio?: string }
router.put('/profile/public', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const cur = req.user;
    const profilePublic = typeof body.profile_public === 'boolean' ? (body.profile_public ? 1 : 0) : (+cur.profile_public || 0);
    const bio = typeof body.bio === 'string' ? body.bio.trim().slice(0, 300) : (cur.bio || '');
    await pool.query('UPDATE users SET profile_public = ?, bio = ? WHERE id = ?', [profilePublic, bio, req.user.id]);
    res.json({ ok: true, profile_public: !!profilePublic, bio });
  } catch (e) { next(e); }
});

// ---------- 公开追番分享页 ----------
// GET /api/share/:uid   (uid = Bangumi UID)
router.get('/share/:uid', async (req, res, next) => {
  try {
    const uid = +req.params.uid;
    if (!uid) return res.status(400).json({ error: '无效的用户' });
    const [users] = await pool.query('SELECT id, bangumi_uid, nickname, username, avatar, bio, profile_public FROM users WHERE bangumi_uid = ?', [uid]);
    if (!users.length) return res.status(404).json({ error: '用户不存在', status: 404 });
    const u = users[0];
    if (+u.profile_public !== 1) return res.status(404).json({ error: '该用户未公开追番分享', status: 404 });
    const [cols] = await pool.query(
      `SELECT subject_id, subject_type, name, name_cn, image, score, status, ep_status, comment, tags, subject_tags, updated_at
       FROM collections WHERE user_id = ? ORDER BY updated_at DESC LIMIT 300`, [u.id]
    );
    const mapped = cols.map(c => ({
      ...c,
      tags: parseTags(c.tags),
      subject_tags: parseTags(c.subject_tags),
      statusText: STATUS_TEXT[c.status] || ''
    }));
    // 概况
    const byStatus = {};
    for (const c of cols) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    const total = cols.length;
    const avg = cols.filter(c => +c.score > 0).reduce((s, c) => s + +c.score, 0);
    const ratedN = cols.filter(c => +c.score > 0).length;
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.json({
      user: {
        uid: u.bangumi_uid,
        nickname: u.nickname || u.username || '',
        avatar: u.avatar || '',
        bio: u.bio || ''
      },
      stats: {
        total,
        byStatus,
        avgScore: ratedN ? +(avg / ratedN).toFixed(1) : 0,
        rated: ratedN
      },
      data: mapped
    });
  } catch (e) { next(e); }
});

// ---------- 收藏数据导出备份 ----------
// GET /api/collections/export-download?format=json|csv
router.get('/collections/export-download', requireAuth, async (req, res, next) => {
  try {
    const fmt = String(req.query.format || 'json').toLowerCase() === 'csv' ? 'csv' : 'json';
    const [rows] = await pool.query(
      'SELECT subject_id, subject_type, name, name_cn, image, score, status, ep_status, comment, tags, subject_tags, updated_at FROM collections WHERE user_id = ? ORDER BY updated_at DESC',
      [req.user.id]
    );
    const stamp = new Date().toISOString().slice(0, 10);
    if (fmt === 'csv') {
      const esc = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const head = ['subject_id', 'subject_type', 'name', 'name_cn', 'image', 'status', 'score', 'ep_status', 'comment', 'tags', 'updated_at'];
      const lines = [head.join(',')];
      for (const c of rows) {
        const tags = [...parseTags(c.tags), ...parseTags(c.subject_tags)].filter(Boolean).join('|');
        lines.push([c.subject_id, c.subject_type, esc(c.name), esc(c.name_cn), esc(c.image), c.status, c.score, c.ep_status, esc(c.comment), esc(tags), c.updated_at].join(','));
      }
      const buf = '\uFEFF' + lines.join('\r\n'); // BOM 便于 Excel 正确识别 UTF-8
      res.setHeader('Content-Disposition', 'attachment; filename="bangumi-collections-' + stamp + '.csv"');
      res.type('text/csv; charset=utf-8');
      return res.send(buf);
    }
    const data = rows.map(c => ({ ...c, tags: parseTags(c.tags), subject_tags: parseTags(c.subject_tags) }));
    res.setHeader('Content-Disposition', 'attachment; filename="bangumi-collections-' + stamp + '.json"');
    res.type('application/json; charset=utf-8');
    res.send(JSON.stringify({ exported_at: new Date().toISOString(), total: data.length, data }, null, 2));
  } catch (e) { next(e); }
});

// ---------- 放送日历 ICS 导出 ----------
// GET /api/calendar.ics  （未来 14 天，日历接口失败时回退本地番剧库 air_date）
function toIcsDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + 'T' + p(d.getUTCHours()) + '0000Z';
}
function escIcs(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

router.get('/calendar.ics', async (req, res, next) => {
  try {
    const events = [];
    const now = new Date();
    let calendar = null;
    try { calendar = await cached('bgm:calendar', 30 * 60 * 1000, () => bgm('/calendar')); } catch (e) { calendar = null; }
    if (Array.isArray(calendar)) {
      // Bangumi 旧版 calendar：数组下标 0=周一 ... 6=周日
      for (let i = 0; i < 14; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        const jsDay = d.getDay(); // 0=Sun
        const idx = jsDay === 0 ? 6 : jsDay - 1; // -> 周一=0
        const day = calendar[idx];
        if (!day || !Array.isArray(day.items)) continue;
        for (const s of day.items) {
          if (!s || !s.id) continue;
          const title = s.name_cn || s.name || '番剧';
          const airDate = s.air_date && /^\d{4}-\d{2}-\d{2}$/.test(String(s.air_date)) ? String(s.air_date) : '';
          const dayStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
          const evDate = airDate || dayStr;
          events.push({
            uid: 'bgm-' + s.id + '-' + evDate,
            dtstamp: toIcsDate(now),
            dtstart: evDate,
            summary: '📺 ' + title,
            desc: (s.summary || '').slice(0, 200),
            url: config.publicBase + '/subject/' + s.id
          });
        }
      }
    }
    // 兜底：本地番剧库中近期开播/放送的动画（air_date 为未来 14 天）
    if (!events.length) {
      const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const b = a + 14 * 86400000;
      const [rows] = await pool.query(
        "SELECT subject_id, name, name_cn, air_date FROM library_subjects WHERE category = 'anime' AND air_date != ''",
        []
      );
      for (const r of rows) {
        const t = new Date(String(r.air_date)).getTime();
        if (!isNaN(t) && t >= a && t < b) {
          events.push({
            uid: 'lib-' + r.subject_id + '-' + r.air_date,
            dtstamp: toIcsDate(now),
            dtstart: r.air_date,
            summary: '📺 ' + (r.name_cn || r.name || '番剧'),
            desc: '',
            url: config.publicBase + '/subject/' + r.subject_id
          });
        }
      }
    }
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mifeng Club//Bangumi Calendar//CN', 'CALSCALE:GREGORIAN',
      'X-WR-CALNAME:秘封俱乐部·放送日历', 'X-WR-TIMEZONE:Asia/Shanghai'
    ];
    for (const e of events) {
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + e.uid);
      lines.push('DTSTAMP:' + e.dtstamp);
      lines.push('DTSTART;VALUE=DATE:' + e.dtstart.replace(/-/g, ''));
      lines.push('SUMMARY:' + escIcs(e.summary));
      if (e.desc) lines.push('DESCRIPTION:' + escIcs(e.desc));
      if (e.url) lines.push('URL:' + e.url);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    res.set('Content-Disposition', 'attachment; filename="bangumi-calendar.ics"');
    res.type('text/calendar; charset=utf-8');
    res.send(lines.join('\r\n') + '\r\n');
  } catch (e) { next(e); }
});

module.exports = router;

