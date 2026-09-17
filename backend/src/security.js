
// security.js - 安全中间件：安全响应头 / CSP / Origin 校验（CSRF）/ 写接口限流
const config = require('./config');

// 请求来源 host（Origin 或 Referer 中解析）
function originOf(req) {
  const origin = req.headers.origin || req.headers.referer || '';
  if (!origin) return '';
  try { return new URL(origin).host; } catch (e) { return ''; }
}

function isLocalDev(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}
// IPv4-mapped IPv6（::ffff:1.2.3.4）统一成 IPv4，避免同一个 IP 出现两种写法
function normIp(ip) {
  const s = String(ip == null ? '' : ip).trim();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  return m ? m[1] : s;
}
// 可信反代来源：只有"本机反代转发过来的连接"才认 X-Forwarded-For。
// 直连后端端口时（socket 就是客户端地址）XFF 完全不可信：否则攻击者一枚请求换一个 XFF，
// 就能刷出无数个"不同 IP"，把按 IP 的登录爆破限流、验证码限流、只读访客限量全部绕过去。
// 生产是 nginx 与后端同机、proxy_pass 127.0.0.1，所以默认只信本机；反代在别的机器上用
// TRUST_PROXY_IPS 显式声明。注意 XFF 取最右一段（nginx 用 $remote_addr 覆盖时只有一段）。
const TRUSTED_PROXY_IPS = new Set([...(config.trustProxyIps || []), '::ffff:127.0.0.1']);
function clientIpOf(req) {
  const sock = normIp(req.socket && req.socket.remoteAddress);
  if (sock && TRUSTED_PROXY_IPS.has(sock)) {
    const fwd = normIp(String(req.headers['x-forwarded-for'] || '').split(',').pop());
    if (fwd) return fwd;
  }
  return sock || 'unknown';
}

function isSameOrigin(req) {
  const o = originOf(req);
  if (!o) return true; // 无 Origin/Referer（curl/脚本等）放行
  const host = req.headers.host || '';
  if (o === host) return true;
  // 本地开发：Vite(5173) -> API(3000) 跨端口，视为同源放行
  try {
    const oh = new URL(o.startsWith('http') ? o : 'http://' + o).hostname;
    const hh = host.split(':')[0];
    if (isLocalDev(oh) && isLocalDev(hh)) return true;
  } catch (e) { /* ignore */ }
  // 允许 PUBLIC_BASE 配置的源（Nginx 反代 / HTTPS 前置场景）
  try {
    if (o === new URL(config.publicBase).host) return true;
  } catch (e) { /* ignore */ }
  return false;
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",   // naive-ui / Vue 需要内联样式
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; '));
  next();
}

// 跨站写请求防护：非 GET 且带跨站 Origin/Referer 一律 403
function originGuard(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (isSameOrigin(req)) return next();
  return res.status(403).json({ error: '跨站请求已拒绝', status: 403 });
}

// 计数桶超量时的清理：只淘汰"最久没活动"的那批，绝不整体 clear()。
// 旧写法 buckets.clear() 会把所有人的计数一起清零——攻击者只要刷出 20000 个不同 IP
// （伪造 XFF 或真实肉鸡都行），就能顺手把自己的限流记录也抹掉，等于给爆破开了后门。
function pruneBuckets(map, maxSize) {
  const now = Date.now();
  for (const [k, arr] of map) {
    // 空桶 / 全部过期的桶直接删掉，顺手回收内存
    if (!Array.isArray(arr) || !arr.length) { map.delete(k); continue; }
    const last = arr[arr.length - 1];
    if (!last || now - last.t > 24 * 3600 * 1000) map.delete(k);
  }
  if (map.size <= maxSize) return;
  const target = Math.max(1, Math.floor(maxSize * 0.9));
  const idle = [];
  for (const [k, arr] of map) idle.push([k, arr[arr.length - 1].t]);
  idle.sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < idle.length && map.size > target; i++) map.delete(idle[i][0]);
}

// 简易内存限流（按 IP + 规则名），用于登录/写接口等敏感路径
const buckets = new Map();
function rateLimit({ windowMs = 60 * 1000, max = 120, name = 'api' } = {}) {
  return (req, res, next) => {
    const ip = clientIpOf(req);
    const now = Date.now();
    const arr = (buckets.get(ip) || []).filter(x => now - x.t < windowMs);
    if (arr.filter(x => x.k === name).length >= max) {
      if (arr.length) buckets.set(ip, arr);
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: '请求过于频繁，请稍后再试', status: 429 });
    }
    arr.push({ t: now, k: name });
    buckets.set(ip, arr);
    if (buckets.size > 20000) pruneBuckets(buckets, 20000); // 防内存无限增长
    next();
  };
}

module.exports = { securityHeaders, originGuard, rateLimit, isSameOrigin, originOf, clientIpOf, pruneBuckets };
