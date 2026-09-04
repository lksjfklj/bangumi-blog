// routes/auth.js - 登录体系：Bangumi OAuth / 本地账号注册登录 / 站长只读访客模式
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { pool } = require('../db');
const { oauthAuthorizeUrl, oauthExchange, bgm, getValidToken } = require('../bangumi');
const { createSession, deleteSession, getUserBySession } = require('../auth');
const { clientIpOf } = require('../security');
const router = express.Router();

// ---------- 密码哈希（scrypt，随机盐） ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
// 用户不存在时用于对齐 scrypt 耗时的假哈希（内容无意义，仅用于计时防枚举）
const DUMMY_STORED = 'scrypt$' + '0'.repeat(32) + '$' + '0'.repeat(128);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return 'scrypt$' + salt + '$' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  if (!stored || !String(stored).startsWith('scrypt$')) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3) return false;
  const salt = parts[1];
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  const a = Buffer.from(hash.toString('hex'), 'hex');
  const b = Buffer.from(parts[2], 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function setSid(res, token, ttlMs = config.sessionTtlMs) {
  // SameSite=strict + HttpOnly：本站是纯同源 SPA，杜绝跨站携带会话 Cookie（CSRF 主防线之一）
  res.cookie('sid', token, { httpOnly: true, sameSite: 'strict', secure: config.secureCookies, maxAge: ttlMs });
}

// 是否站长（Bangumi UID 匹配或已标记 is_owner）
function isOwnerUser(row) {
  return +row.is_owner === 1 || (config.ownerBangumiUid > 0 && +row.bangumi_uid === config.ownerBangumiUid);
}

async function markOwner(row) {
  if (isOwnerUser(row)) {
    try { await pool.query('UPDATE users SET is_owner = 1 WHERE id = ?', [row.id]); } catch (e) { /* ignore */ }
  }
}

// ---------- Bangumi OAuth ----------
// 发起登录：跳转 bgm.tv OAuth
router.get('/bangumi', (req, res) => {
  if (!config.bangumi.clientId) {
    return res.status(503).json({ error: '尚未配置 Bangumi OAuth 应用（CLIENT_ID）' });
  }
  const state = crypto.randomBytes(8).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(oauthAuthorizeUrl(state));
});

// OAuth 回调
router.get('/callback', async (req, res, next) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect('/login?login_error=' + encodeURIComponent(error));
    if (state && req.cookies.oauth_state && state !== req.cookies.oauth_state) {
      return res.redirect('/login?login_error=state_mismatch');
    }
    if (!code) return res.status(400).json({ error: '缺少 code' });
    const data = await oauthExchange(code);
    if (!data || !data.access_token) {
      return res.redirect('/login?login_error=token_failed');
    }
    const me = await bgm('/v0/me', { token: data.access_token });
    const uid = me.id;
    const nickname = me.nickname || me.username || 'Bangumi 用户';
    const avatar = (me.avatar && me.avatar.large) || '';
    const expiresAt = Date.now() + (data.expires_in || 604800) * 1000;

    const [existing] = await pool.query('SELECT * FROM users WHERE bangumi_uid = ?', [uid]);
    let userId;
    if (existing.length) {
      userId = existing[0].id;
      await pool.query(
        'UPDATE users SET nickname = ?, avatar = ?, access_token = ?, refresh_token = ?, token_expires_at = ?, is_owner = ? WHERE id = ?',
        [nickname, avatar, data.access_token, data.refresh_token || existing[0].refresh_token, expiresAt, isOwnerUser(existing[0]) ? 1 : 0, userId]
      );
    } else {
      const [ins] = await pool.query(
        'INSERT INTO users (bangumi_uid, username, nickname, avatar, access_token, refresh_token, token_expires_at, is_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [uid, me.username || '', nickname, avatar, data.access_token, data.refresh_token || '', expiresAt, config.ownerBangumiUid === uid ? 1 : 0]
      );
      userId = ins.insertId;
    }
    const { token } = await createSession(userId, 'user');
    res.clearCookie('oauth_state');
    setSid(res, token);
    res.redirect('/collection?login=1');
  } catch (e) { next(e); }
});


// ---------- 简单内存限流（按 IP，防爆破） ----------
const rateBuckets = new Map(); // ip -> [{ t, kind }]
function clientIp(req) {
  return clientIpOf(req);
}
function checkRate(req, kind, limit, windowMs) {
  const ip = clientIp(req);
  const now = Date.now();
  const arr = (rateBuckets.get(ip) || []).filter(x => now - x.t < windowMs);
  const mine = arr.filter(x => x.kind === kind);
  if (mine.length >= limit) return false;
  arr.push({ t: now, kind });
  rateBuckets.set(ip, arr);
  if (rateBuckets.size > 10000) rateBuckets.clear(); // 防内存无限增长
  return true;
}

// ---------- 本地账号 ----------
// 邮箱格式校验
function validEmail(v) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || '').trim());
}

// 发送邮箱注册验证码（邮件由 SMTP 发送；未配置 SMTP 时返回 503）
router.post('/mail/request-code', async (req, res, next) => {
  try {
    if (!checkRate(req, 'mail_code', 3, 10 * 60 * 1000)) {
      return res.status(429).json({ error: '验证码请求过于频繁，请 10 分钟后再试' });
    }
    const email = String(((req.body || {}).email) || '').trim().toLowerCase();
    if (!validEmail(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    if (!config.smtp.host || !config.smtp.user) {
      return res.status(503).json({ error: '服务器尚未配置 SMTP，暂无法发送邮箱验证码' });
    }
    const [dup] = await pool.query('SELECT id FROM users WHERE email = ? AND password_hash IS NOT NULL', [email]);
    if (dup.length) return res.status(409).json({ error: '该邮箱已被注册，请直接登录' });
    // M3：同一邮箱每 10 分钟最多发送 1 封验证码（以 DB 记录为准，重启后仍生效）
    const cutoff10 = new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const [recent] = await pool.query(
      'SELECT COUNT(*) AS n FROM email_verify_codes WHERE email = ? AND purpose = ? AND created_at >= ?',
      [email, 'register', cutoff10]
    );
    if (recent[0].n > 0) {
      return res.status(429).json({ error: '该邮箱验证码请求过于频繁，请 10 分钟后再试' });
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const now = Date.now();
    // 先使该邮箱旧的未用验证码全部失效，避免多个验证码并存造成混淆
    await pool.query(
      "UPDATE email_verify_codes SET used_at = ? WHERE email = ? AND purpose = 'register' AND used_at = 0",
      [now, email]
    );
    await pool.query(
      "INSERT INTO email_verify_codes (email, code, purpose, expires_at, used_at, created_at) VALUES (?, ?, 'register', ?, 0, ?)",
      [email, code, now + config.mailCodeTtlMs, now]
    );
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined
      });
      await transporter.sendMail({
        from: config.smtp.from || config.smtp.user,
        to: email,
        subject: '【秘封俱乐部】注册验证码',
        text: '你的注册验证码是：' + code + '（' + Math.round(config.mailCodeTtlMs / 60000) + ' 分钟内有效）。如果不是你本人操作，请忽略本邮件。'
      });
    } catch (e) {
      // 发送失败则作废刚生成的验证码，避免被猜到后用
      await pool.query(
        "UPDATE email_verify_codes SET used_at = ? WHERE email = ? AND purpose = 'register' AND code = ?",
        [Date.now(), email, code]
      );
      console.error('[auth] send register mail failed', email, ':', e && e.message);
      return res.status(502).json({ error: '验证码邮件发送失败，请稍后再试' });
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 注册（需邮箱验证码，防止匿名批量注册/占用户名）
router.post('/register', async (req, res, next) => {
  try {
    if (!checkRate(req, 'register', 5, 10 * 60 * 1000)) {
      return res.status(429).json({ error: '注册过于频繁，请稍后再试' });
    }
    const { username, password, nickname, email, code } = req.body || {};
    const name = String(username || '').trim();
    const pwd = String(password || '');
    const mail = String(email || '').trim().toLowerCase();
    const veri = String(code || '').trim();
    if (!/^[A-Za-z0-9_\u4e00-\u9fa5]{2,24}$/.test(name)) {
      return res.status(400).json({ error: '用户名需为 2-24 位字母/数字/下划线/中文' });
    }
    if (pwd.length < 8 || pwd.length > 72) {
      return res.status(400).json({ error: '密码长度需为 8-72 位' });
    }
    if (!validEmail(mail)) return res.status(400).json({ error: '请填写正确的邮箱' });
    if (!/^\d{6}$/.test(veri)) return res.status(400).json({ error: '请填写 6 位邮箱验证码' });
    const [codes] = await pool.query(
      "SELECT * FROM email_verify_codes WHERE email = ? AND purpose = 'register' AND used_at = 0 ORDER BY id DESC LIMIT 1",
      [mail]
    );
    const row = codes[0];
    if (!row || row.expires_at <= Date.now()) {
      return res.status(400).json({ error: '验证码错误或已过期，请重新获取' });
    }
    if (row.code !== veri) {
      // M3：校验失败计数，连续错 5 次作废该验证码，防爆破 6 位数字验证码
      const fails = +(row.fail_count || 0) + 1;
      await pool.query('UPDATE email_verify_codes SET fail_count = ? WHERE id = ?', [fails, row.id]);
      if (fails >= 5) {
        await pool.query('UPDATE email_verify_codes SET used_at = ?, fail_count = ? WHERE id = ? AND used_at = 0', [Date.now(), fails, row.id]);
        return res.status(429).json({ error: '验证码错误次数过多，验证码已作废，请重新获取' });
      }
      return res.status(400).json({ error: '验证码错误或已过期，请重新获取' });
    }
    const [dupUser] = await pool.query(
      'SELECT id FROM users WHERE (username = ? OR LOWER(username) = LOWER(?)) AND password_hash IS NOT NULL',
      [name, name]
    );
    if (dupUser.length) return res.status(409).json({ error: '用户名已被占用' });
    const [dupMail] = await pool.query(
      'SELECT id FROM users WHERE email = ? AND password_hash IS NOT NULL',
      [mail]
    );
    if (dupMail.length) return res.status(409).json({ error: '该邮箱已被注册，请直接登录' });
    const [upd] = await pool.query(
      'UPDATE email_verify_codes SET used_at = ? WHERE id = ? AND used_at = 0',
      [Date.now(), row.id]
    );
    if (!upd.affectedRows) return res.status(400).json({ error: '验证码已被使用，请重新获取' });
    const [ins] = await pool.query(
      'INSERT INTO users (username, nickname, password_hash, email, email_verified_at, is_owner) VALUES (?, ?, ?, ?, ?, 0)',
      [name, String(nickname || '').trim().slice(0, 32) || name, hashPassword(pwd), mail, Date.now()]
    );
    const { token } = await createSession(ins.insertId, 'user');
    setSid(res, token);
    res.json({ ok: true, user: { id: ins.insertId, username: name, nickname: nickname || name, role: 'user' } });
  } catch (e) { next(e); }
});

// 登录
router.post('/login', async (req, res, next) => {
  try {
    if (!checkRate(req, 'login', 10, 60 * 1000)) {
      return res.status(429).json({ error: '尝试过于频繁，请 1 分钟后再试' });
    }
    const { username, password } = req.body || {};
    const name = String(username || '').trim();
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ? AND password_hash IS NOT NULL', [name]);
    if (!rows.length) {
      // L1：用户不存在也执行一次 scrypt，耗时与“密码错误”对齐，防止枚举本地账号
      verifyPassword(String(password || ''), DUMMY_STORED);
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (!verifyPassword(String(password || ''), rows[0].password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const user = rows[0];
    await markOwner(user);
    const { token } = await createSession(user.id, 'user');
    setSid(res, token);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- 站长只读访客模式 ----------
// 不登录，以站长身份进入只读浏览（写接口一律 403）
router.post('/viewer', async (req, res, next) => {
  try {
    // H2：viewer 会话按真实来源 IP 限流（每 10 分钟 5 次），防止被刷出大量只读会话
    if (!checkRate(req, 'viewer', 5, 10 * 60 * 1000)) {
      return res.status(429).json({ error: '访问过于频繁，请 10 分钟后再试' });
    }
    const [rows] = await pool.query('SELECT * FROM users WHERE is_owner = 1 ORDER BY id LIMIT 1');
    if (!rows.length) return res.status(400).json({ error: '尚未初始化站长账号' });
    const owner = rows[0];
    const { token } = await createSession(owner.id, 'viewer', config.viewerSessionTtlMs);
    setSid(res, token, config.viewerSessionTtlMs);
    res.json({ ok: true, viewer: true, user: {
      id: owner.id,
      bangumi_uid: owner.bangumi_uid,
      nickname: owner.nickname,
      avatar: owner.avatar,
      role: 'viewer'
    } });
  } catch (e) { next(e); }
});

// ---------- 当前用户 ----------
router.get('/me', async (req, res) => {
  if (!req.user) return res.json({ user: null, viewer: false });
  const token = await getValidToken(req.user);
  const isOwner = +req.user.is_owner === 1;
  const viewer = req.user.kind === 'viewer';
  const role = viewer ? 'viewer' : (isOwner ? 'owner' : 'user');
  res.json({ user: {
    id: req.user.id,
    bangumi_uid: req.user.bangumi_uid,
    username: req.user.username,
    nickname: req.user.nickname,
    avatar: req.user.avatar,
    profile_public: +req.user.profile_public === 1,
    bio: req.user.bio || '',
    connected: !!token,
    is_owner: isOwner,
    role
  }, viewer });
});

// 登出
router.post('/logout', async (req, res, next) => {
  try {
    if (req.cookies.sid) await deleteSession(req.cookies.sid);
    res.clearCookie('sid');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;

