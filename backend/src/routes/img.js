// routes/img.js - 图片代理缓存（lain.bgm.tv 国内不可直连）
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ProxyAgent } = require('undici');
const { safeFetch } = require('../safefetch');
const config = require('../config');
const router = express.Router();

let dispatcher = null;
if (config.bangumi.proxy) dispatcher = new ProxyAgent(config.bangumi.proxy);

const ALLOWED_HOSTS = /(^|\.)(bgm\.tv|lain\.bgm\.tv|t\.vndb\.org|s\.vndb\.org)$/i;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 单张图上限 10MB：超过直接中止，避免超大响应吃满内存
const MAX_CACHE_FILES = 4000;             // 缓存文件数上限：超出按最旧淘汰，避免被刷爆磁盘

// 缓存 key 只用 host + path，**故意忽略 query**：
//   1) 图床都是静态路径，同一路径不同 query 内容一致（库内确认过图片 URL 无 query）；
//   2) 旧实现用 url.href 做 key，任何人 ?a=1 / ?a=2 / ?a=3 ... 就能刷出无限个 key 写爆磁盘。
function cacheKeyOf(url) {
  return crypto.createHash('md5').update(url.host.toLowerCase() + url.pathname).digest('hex');
}

// 按 mtime 淘汰最旧缓存；同一时刻只允许一个淘汰流程
let pruning = false;
function pruneCache(dir, keep) {
  if (pruning) return;
  pruning = true;
  fs.readdir(dir, (err, names) => {
    try {
      if (err || !names || names.length <= keep) return;
      const files = [];
      for (const n of names) {
        try { files.push({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }); } catch (e) { /* 并发被删 */ }
      }
      files.sort((a, b) => a.t - b.t);
      for (const f of files.slice(0, Math.max(0, files.length - keep))) {
        try { fs.unlinkSync(path.join(dir, f.n)); } catch (e) { /* 忽略 */ }
      }
    } finally {
      pruning = false;
    }
  });
}

// 带上限读取响应体：Content-Length 先挡一道，边读边计数再挡一道
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('image too large');
  if (!res.body) return Buffer.alloc(0);
  if (typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('image too large');
    return buf;
  }
  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new Error('image too large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { await reader.cancel(); } catch (e) { /* 已读完/已中止 */ }
  }
  return Buffer.concat(chunks);
}

router.get('/', async (req, res) => {
  const u = req.query.u || req.query.url || '';
  if (Array.isArray(u)) return res.status(400).send('bad url'); // ?u=a&u=b -> 数组
  let url;
  try { url = new URL(String(u)); } catch (e) { return res.status(400).send('bad url'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return res.status(400).send('bad protocol');
  if (url.username || url.password) return res.status(400).send('bad url');
  if (!ALLOWED_HOSTS.test(url.hostname)) return res.status(403).send('host not allowed');

  fs.mkdirSync(config.imgCacheDir, { recursive: true });
  const key = cacheKeyOf(url);
  const ext = path.extname(url.pathname) || '.bin'; // 原写法 (key + ext) || '.bin' 优先级写错，兜底从未生效
  const file = path.join(config.imgCacheDir, key + ext);
  const cacheHits = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 30 * 24 * 3600 * 1000;
  if (cacheHits) {
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Img-Cache', 'HIT');
    return res.sendFile(file);
  }

  try {
    // safeFetch：3xx 不自动跟随，且每一跳都必须仍然落在白名单图床内
    const upstream = await safeFetch(url.href, {
      ...(dispatcher ? { dispatcher } : {}),
      signal: AbortSignal.timeout(15000)
    }, { allowHost: (h) => ALLOWED_HOSTS.test(h) });
    if (!upstream.ok) return res.status(502).send('upstream ' + upstream.status);
    const type = upstream.headers.get('content-type') || '';
    // 白名单里含 bgm.tv 主站，主站会返回 HTML；挡掉非图片响应，避免把网页当图片缓存并对外提供
    if (type && !/^image\//i.test(type)) return res.status(502).send('not an image');
    const buf = await readCapped(upstream, MAX_IMAGE_BYTES);
    if (!buf.length) return res.status(502).send('empty image');
    fs.writeFile(file, buf, () => {});
    pruneCache(config.imgCacheDir, MAX_CACHE_FILES);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Img-Cache', 'MISS');
    res.set('Content-Type', type || 'image/jpeg');
    res.send(buf);
  } catch (e) {
    // 代理不可用时尽量返回本地缓存
    if (fs.existsSync(file)) return res.sendFile(file);
    res.status(502).send('image proxy unavailable');
  }
});

module.exports = router;
