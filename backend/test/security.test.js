// security.test.js - Origin 校验（CSRF 防护核心逻辑）单测
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isSameOrigin, originOf } = require('../src/security');

function req({ origin, referer, host }) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (referer !== undefined) headers.referer = referer;
  if (host !== undefined) headers.host = host;
  return { headers };
}

test('isSameOrigin: 同源 Origin 放行', () => {
  assert.equal(isSameOrigin(req({ origin: 'https://example.com', host: 'example.com' })), true);
  assert.equal(isSameOrigin(req({ origin: 'https://api.example.com:8443', host: 'api.example.com:8443' })), true);
});

test('isSameOrigin: 无 Origin/Referer（curl/脚本）放行', () => {
  assert.equal(isSameOrigin(req({ host: 'example.com' })), true);
  assert.equal(isSameOrigin(req({})), true);
});

test('isSameOrigin: 跨站 Origin / Referer 拒绝', () => {
  assert.equal(isSameOrigin(req({ origin: 'https://evil.com', host: 'example.com' })), false);
  assert.equal(isSameOrigin(req({ referer: 'https://evil.com/page', host: 'example.com' })), false);
  assert.equal(isSameOrigin(req({ origin: 'https://example.com.evil.com', host: 'example.com' })), false);
});

test('isSameOrigin: 本地开发跨端口（Vite 5173 -> API 3000）放行', () => {
  assert.equal(isSameOrigin(req({ origin: 'http://localhost:5173', host: 'localhost:3000' })), true);
  assert.equal(isSameOrigin(req({ origin: 'http://127.0.0.1:5173', host: '127.0.0.1:3000' })), true);
});

test('originOf: 从 Origin/Referer 解析 host', () => {
  assert.equal(originOf(req({ origin: 'https://example.com:8443' })), 'example.com:8443');
  assert.equal(originOf(req({ referer: 'https://sub.example.com/path' })), 'sub.example.com');
  assert.equal(originOf(req({})), '');
  assert.equal(originOf(req({ origin: 'not-a-url' })), '');
});

// XFF 伪造防护：取最右一段可信来源 IP
const { clientIpOf } = require('../src/security');

test('clientIpOf: 无 XFF 时回退 socket 地址', () => {
  assert.equal(clientIpOf({ headers: {}, socket: { remoteAddress: '1.2.3.4' } }), '1.2.3.4');
});

test('clientIpOf: 单段 XFF 直接返回（nginx 已覆盖为 $remote_addr 的场景）', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientIpOf(req), '203.0.113.9');
});

test('clientIpOf: 多段 XFF 取最右一段，忽略客户端伪造的前缀', () => {
  const req = { headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientIpOf(req), '198.51.100.7');
});

test('clientIpOf: 空 XFF 回退 socket', () => {
  const req = { headers: { 'x-forwarded-for': '' }, socket: { remoteAddress: '::1' } };
  assert.equal(clientIpOf(req), '::1');
});

// 直连后端端口时必须完全无视 XFF：否则攻击者一枚请求换一个 XFF 就能刷出无数个"IP"绕过限流
test('clientIpOf: 直连（socket 不是本机反代）时忽略伪造的 XFF', () => {
  const req = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '203.0.113.9' } };
  assert.equal(clientIpOf(req), '203.0.113.9');
  const req2 = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socket: { remoteAddress: '203.0.113.9' } };
  assert.equal(clientIpOf(req2), '203.0.113.9');
});

test('clientIpOf: ::ffff:127.0.0.1 仍算本机反代；IPv4-mapped 地址统一成 IPv4', () => {
  const via = { headers: { 'x-forwarded-for': '198.51.100.7' }, socket: { remoteAddress: '::ffff:127.0.0.1' } };
  assert.equal(clientIpOf(via), '198.51.100.7');
  const direct = { headers: {}, socket: { remoteAddress: '::ffff:1.2.3.4' } };
  assert.equal(clientIpOf(direct), '1.2.3.4');
});

test('clientIpOf: 完全没有 socket 信息时不崩，返回 unknown', () => {
  assert.equal(clientIpOf({ headers: {} }), 'unknown');
  assert.equal(clientIpOf({ headers: {}, socket: {} }), 'unknown');
});

// 限流计数桶超量淘汰：绝不能整体 clear（那会让攻击者刷满阈值顺手重置自己的计数）
const { pruneBuckets, rateLimit } = require('../src/security');

test('pruneBuckets: 空桶直接删掉，未超量时不动别人', () => {
  const m = new Map([['a', []], ['b', [{ t: Date.now(), k: 'x' }]]]);
  pruneBuckets(m, 10);
  assert.deepEqual([...m.keys()], ['b']);
});

test('pruneBuckets: 超量时只淘汰最久没活动的那批，保留最近的', () => {
  const t = Date.now();
  const m = new Map([
    ['old1', [{ t: t - 5000, k: 'x' }]],
    ['old2', [{ t: t - 4000, k: 'x' }]],
    ['mid', [{ t: t - 3000, k: 'x' }]],
    ['new1', [{ t: t - 2000, k: 'x' }]],
    ['new2', [{ t: t - 1000, k: 'x' }]]
  ]);
  pruneBuckets(m, 3);
  assert.equal(m.size, 2);
  assert.ok(m.has('new1') && m.has('new2'), '应保留最近活动的两个桶');
});

function fakeRes() {
  return {
    code: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json() { return this; }
  };
}
function fakeReq(ip, socket) {
  return { headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: socket || '127.0.0.1' } };
}

test('rateLimit: 同 IP 超过上限返回 429，未超限的 IP 不受影响', () => {
  const name = 'unit-' + Math.random().toString(36).slice(2);
  const mw = rateLimit({ windowMs: 60 * 1000, max: 2, name });
  let passed = 0;
  const next = () => { passed++; };
  mw(fakeReq('203.0.113.11'), fakeRes(), next);
  mw(fakeReq('203.0.113.11'), fakeRes(), next);
  const blocked = fakeRes();
  mw(fakeReq('203.0.113.11'), blocked, next);
  assert.equal(blocked.code, 429);
  assert.equal(blocked.headers['Retry-After'], 60);
  const other = fakeRes();
  mw(fakeReq('203.0.113.12'), other, next);
  assert.equal(other.code, 200);
  assert.equal(passed, 3, '只有被限流的那一次没有放行');
});

test('rateLimit: 直连伪造 XFF 换 IP 也没用（按 socket 地址计数）', () => {
  const name = 'unit-direct-' + Math.random().toString(36).slice(2);
  const mw = rateLimit({ windowMs: 60 * 1000, max: 1, name });
  const next = () => {};
  mw({ headers: { 'x-forwarded-for': 'a1' }, socket: { remoteAddress: '203.0.113.21' } }, fakeRes(), next);
  const res2 = fakeRes();
  mw({ headers: { 'x-forwarded-for': 'a2' }, socket: { remoteAddress: '203.0.113.21' } }, res2, next);
  assert.equal(res2.code, 429);
});
