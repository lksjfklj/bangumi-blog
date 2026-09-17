// bangumi.js - Bangumi API 客户端（支持代理出口 + 数据库缓存兜底）
const { fetch, ProxyAgent } = require('undici');
const config = require('./config');
const { pool } = require('./db');

const API_BASE = 'https://api.bgm.tv';
const WEB_BASE = 'https://bgm.tv';

let dispatcher = null;
if (config.bangumi.proxy) {
  dispatcher = new ProxyAgent(config.bangumi.proxy);
}

class BgmError extends Error {
  constructor(status, body) {
    super('Bangumi API error: ' + status);
    this.status = status;
    this.body = body;
  }
}

async function rawRequest(url, { method = 'GET', headers = {}, body, token } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'User-Agent': config.bangumi.userAgent,
      Accept: 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body && !headers['Content-Type'] ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    ...(dispatcher ? { dispatcher } : {}),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) {
    let errBody = null;
    try { errBody = await res.json(); } catch (e) { /* ignore */ }
    const err = new BgmError(res.status, errBody);
    throw err;
  }
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return text; }
}

async function bgm(path, opts = {}) {
  const url = /^https?:\/\//.test(path) ? path : API_BASE + path;
  return rawRequest(url, opts);
}

async function bgmWeb(path, opts = {}) {
  const url = /^https?:\/\//.test(path) ? path : WEB_BASE + path;
  return rawRequest(url, opts);
}

// 带缓存的请求：先查缓存，miss 或过期则请求并回填；请求失败时返回过期缓存兜底
async function cached(key, ttlMs, fn) {
  const now = Date.now();
  try {
    const [rows] = await pool.query('SELECT value, expires_at FROM cache WHERE cache_key = ?', [key]);
    if (rows.length && rows[0].expires_at > now) {
      return JSON.parse(rows[0].value);
    }
  } catch (e) { /* cache read fail -> ignore */ }

  try {
    const data = await fn();
    try {
      await pool.query(
        'INSERT INTO cache (cache_key, value, expires_at) VALUES (?, ?, ?)' + ' ON CONFLICT(cache_key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
        [key, JSON.stringify(data), now + ttlMs]
      );
    } catch (e) { /* cache write fail -> ignore */ }
    return data;
  } catch (err) {
    // 请求失败：尝试返回过期缓存
    try {
      const [rows] = await pool.query('SELECT value, expires_at FROM cache WHERE cache_key = ?', [key]);
      if (rows.length) return JSON.parse(rows[0].value);
    } catch (e) { /* ignore */ }
    throw err;
  }
}

// ---------- OAuth ----------
function oauthAuthorizeUrl(state) {
  const q = new URLSearchParams({
    client_id: config.bangumi.clientId,
    response_type: 'code',
    redirect_uri: config.bangumi.redirectUri,
    state: state || ''
  });
  return WEB_BASE + '/oauth/authorize?' + q.toString();
}

async function oauthExchange(code) {
  return rawRequest(WEB_BASE + '/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      grant_type: 'authorization_code',
      client_id: config.bangumi.clientId,
      client_secret: config.bangumi.clientSecret,
      code,
      redirect_uri: config.bangumi.redirectUri
    }
  });
}

async function oauthRefresh(refreshToken) {
  return rawRequest(WEB_BASE + '/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      grant_type: 'refresh_token',
      client_id: config.bangumi.clientId,
      client_secret: config.bangumi.clientSecret,
      refresh_token: refreshToken
    }
  });
}

// 获取有效 access_token（自动刷新并更新数据库）
// 注意：Bangumi 的 refresh_token 是一次性的（刷新成功后旧令牌立即作废）。
// 若同一时刻有多个请求拿着同一个旧 refresh_token 去刷新（页面 /me、自动同步、收藏写入几乎同时触发），
// Bangumi 会判定为令牌重放，把整条令牌链作废（invalid_grant），此后只能重新授权。
// 因此这里做了两件事：① 每次都先取数据库里的最新令牌；② 同一用户的并发刷新串行化，只让第一个真正去刷。
const refreshLocks = new Map(); // userId -> Promise<string|null>

async function doRefreshToken(user) {
  try {
    const data = await oauthRefresh(user.refresh_token);
    if (!data || !data.access_token) return null;
    const expiresAt = Date.now() + (data.expires_in || 604800) * 1000;
    const refresh = data.refresh_token || user.refresh_token;
    await pool.query(
      'UPDATE users SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE id = ?',
      [data.access_token, refresh, expiresAt, user.id]
    );
    user.access_token = data.access_token;
    user.refresh_token = refresh;
    user.token_expires_at = expiresAt;
    return data.access_token;
  } catch (e) {
    const code = e && e.body && e.body.error;
    console.error('[bangumi] token refresh failed for user', user.id, ':',
      (e && e.status) || '', code || (e && e.message));
    if (e && e.status === 400 && code === 'invalid_grant') {
      // 授权已被 Bangumi 作废：清掉令牌，避免之后每个请求都白跑一次网络。
      // 前端 /auth/me 会拿到 connected=false，并提示用户重新连接 Bangumi。
      try {
        await pool.query('UPDATE users SET access_token = NULL, refresh_token = NULL, token_expires_at = 0 WHERE id = ?', [user.id]);
      } catch (e2) { /* ignore */ }
      user.access_token = null;
      user.refresh_token = null;
      user.token_expires_at = 0;
    }
    return null;
  }
}

async function getValidToken(user) {
  if (!user) return null;
  // 以数据库为准：调用方可能持有的是几秒前的旧快照（并发时会让同一个 refresh_token 被用两次）
  if (user.id) {
    try {
      const [rows] = await pool.query('SELECT access_token, refresh_token, token_expires_at FROM users WHERE id = ?', [user.id]);
      if (rows && rows.length) {
        Object.assign(user, {
          access_token: rows[0].access_token,
          refresh_token: rows[0].refresh_token,
          token_expires_at: rows[0].token_expires_at
        });
      }
    } catch (e) { /* 查库失败则退回调用方快照 */ }
  }
  const now = Date.now();
  if (user.access_token && (+user.token_expires_at || 0) > now + 60 * 1000) return user.access_token;
  if (!user.refresh_token) return null;
  const key = user.id != null ? user.id : 'anon';
  if (refreshLocks.has(key)) return await refreshLocks.get(key);
  const pending = doRefreshToken(user).finally(() => refreshLocks.delete(key));
  refreshLocks.set(key, pending);
  return await pending;
}
module.exports = { bgm, bgmWeb, cached, oauthAuthorizeUrl, oauthExchange, oauthRefresh, getValidToken, BgmError };
