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
