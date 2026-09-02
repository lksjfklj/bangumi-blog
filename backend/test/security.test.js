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
