// safefetch.js - 带 SSRF 防护的 fetch 封装
//
// 适用场景：目标 URL 来自用户输入或第三方内容（用户自定义 Webhook、RSS 文章链接等）。
//
// 为什么不能只用裸 fetch + 事先校验一次地址：
//   fetch 默认 redirect:'follow'。即使首跳校验通过，只要对方返回一个
//   302 Location: http://127.0.0.1:8080/... （或 169.254.169.254 云元数据），
//   请求就会被自动转发到内网 —— 这是 SSRF 最经典的绕法。
//   因此这里改成 redirect:'manual'，每一跳都重新做协议 + 地址 + DNS 解析校验。
//
// 注意：DNS 校验与真正建连之间存在 TOCTOU 窗口，理论上可用 DNS rebinding 绕过；
// 要彻底封死需要把解析结果钉进 dispatcher 的 lookup，属于另一个量级的改造。
// 对本站（个人站、用户 Webhook 仅站长/登录用户可配）当前强度足够。

const dns = require('dns');
const { fetch } = require('undici');

const MAX_REDIRECTS = 3;

// 拒绝回环 / 私网 / 链路本地 / 云元数据 / 组播保留等地址（含 IPv4/IPv6 字面量与 localhost）
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;        // 链路本地（含云元数据 169.254.169.254）
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 私网 172.16/12
    if (p[0] === 192 && p[1] === 168) return true;        // 私网 192.168/16
    if (p[0] >= 224) return true;                         // 组播/保留
    return false;
  }
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true;                                  // 未指定/回环
    if (/^fe80:/i.test(h) || /^fc/i.test(h) || /^fd/i.test(h)) return true;      // 链路本地/ULA
    if (/^2001:db8:/i.test(h)) return true;                                      // 文档段
    const emb = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);                // IPv4 映射
    if (emb) return isPrivateHost(emb[1]);
    return false;
  }
  return false; // 普通域名暂放行，发送前按 DNS 解析结果二次校验
}

function hostOf(u) {
  return String((u && u.hostname) || '').replace(/^\[|\]$/g, '').toLowerCase();
}

function isIpLiteral(host) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
}

// 同步校验：协议白名单 + 字面量地址（保存设置等无法 await 的场景用这个）
function isSafeHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (e) { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  return !isPrivateHost(hostOf(u));
}

// 异步校验：域名还要确认解析结果全部是公网地址
async function isSafeResolvedUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (e) { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = hostOf(u);
  if (isPrivateHost(host)) return false;
  if (isIpLiteral(host)) return true;
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    if (!addrs || !addrs.length) return false;
    return addrs.every(a => !isPrivateHost(a.address));
  } catch (e) {
    // DNS 解析失败：放行交给 fetch（会自然失败），避免因临时 DNS 抖动误伤
    return true;
  }
}

// 逐跳校验的 fetch：redirect 一律手动处理，任何一跳命中内网就抛错
// fetchImpl 是给单测注入桩用的口子（默认就是 undici 的 fetch），生产调用不会传
async function safeFetch(raw, opts = {}, { maxRedirects = MAX_REDIRECTS, allowHost = null, fetchImpl = fetch } = {}) {
  let current;
  try { current = new URL(String(raw)); } catch (e) { throw new Error('bad url'); }
  for (let hop = 0; ; hop++) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') {
      throw new Error('blocked protocol: ' + current.protocol);
    }
    if (allowHost && !allowHost(current.hostname)) {
      throw new Error('blocked host: ' + current.hostname);
    }
    if (!(await isSafeResolvedUrl(current.href))) {
      throw new Error('blocked unsafe address: ' + current.hostname);
    }
    const res = await fetchImpl(current.href, { ...opts, redirect: 'manual' });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) return res;
    // 3xx：先放掉响应体，再自己算下一跳（相对 Location 要按当前地址解析）
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (e) { /* 忽略 */ }
    if (hop >= maxRedirects) throw new Error('too many redirects');
    try { current = new URL(loc, current); } catch (e) { throw new Error('bad redirect location'); }
  }
}

module.exports = { isPrivateHost, isSafeHttpUrl, isSafeResolvedUrl, safeFetch, MAX_REDIRECTS };
