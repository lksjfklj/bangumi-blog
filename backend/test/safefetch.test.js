// safefetch.test.js - SSRF 防护单测
// 背景：Webhook / 图片代理 / RSS 抓取的目标地址都可能被外部内容控制。
// 裸 fetch 默认跟随 302，只要首跳是公网、第二跳指到 127.0.0.1 或 169.254.169.254，
// 请求就会真的打进内网（云元数据可拿到临时凭证）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateHost, isSafeHttpUrl, safeFetch } = require('../src/safefetch');

test('isPrivateHost: 回环/私网/链路本地/云元数据/V6 一律命中', () => {
  for (const h of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.254',
    '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', 'localhost', 'a.localhost',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:127.0.0.1', '']) {
    assert.equal(isPrivateHost(h), true, h + ' 应判定为内网');
  }
});

test('isPrivateHost: 公网地址/普通域名放行', () => {
  for (const h of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', 'example.com', 'lain.bgm.tv', '2606:4700::1111']) {
    assert.equal(isPrivateHost(h), false, h + ' 不应判定为内网');
  }
});

test('isSafeHttpUrl: 拒绝非 http(s) 协议与内网字面量', () => {
  assert.equal(isSafeHttpUrl('https://example.com/hook'), true);
  assert.equal(isSafeHttpUrl('http://8.8.8.8/hook'), true);
  assert.equal(isSafeHttpUrl('file:///etc/passwd'), false);
  assert.equal(isSafeHttpUrl('gopher://127.0.0.1:6379/_info'), false);
  assert.equal(isSafeHttpUrl('http://127.0.0.1:8080/hook'), false);
  assert.equal(isSafeHttpUrl('http://169.254.169.254/latest/meta-data/'), false);
  assert.equal(isSafeHttpUrl('http://[::1]:8080/'), false);
  assert.equal(isSafeHttpUrl('not a url'), false);
  assert.equal(isSafeHttpUrl(''), false);
  assert.equal(isSafeHttpUrl(undefined), false);
});

test('safeFetch: 首跳就是内网字面量时不发出任何请求', async () => {
  let called = 0;
  const stub = async () => { called++; return new Response(null, { status: 200 }); };
  await assert.rejects(() => safeFetch('http://127.0.0.1:8080/admin', {}, { fetchImpl: stub }), /blocked unsafe address/);
  await assert.rejects(() => safeFetch('http://169.254.169.254/latest/meta-data/', {}, { fetchImpl: stub }), /blocked unsafe address/);
  assert.equal(called, 0);
});

test('safeFetch: 302 指向内网时在发第二跳前拒绝（经典 SSRF 绕法）', async () => {
  const urls = [];
  const stub = async (u) => {
    urls.push(String(u));
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:45999/internal-admin' } });
  };
  await assert.rejects(() => safeFetch('http://8.8.8.8/hook', { method: 'POST' }, { fetchImpl: stub }), /blocked unsafe address/);
  assert.deepEqual(urls, ['http://8.8.8.8/hook']); // 只发出了首跳
});

test('safeFetch: 302 指向云元数据同样拒绝', async () => {
  const stub = async () => new Response(null, {
    status: 302,
    headers: { location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' }
  });
  await assert.rejects(() => safeFetch('https://8.8.8.8/hook', {}, { fetchImpl: stub, }), /blocked unsafe address/);
});

test('safeFetch: 相对 Location 按当前地址解析，且仍在公网时正常跟随', async () => {
  const urls = [];
  const stub = async (u) => {
    urls.push(String(u));
    if (urls.length === 1) return new Response(null, { status: 301, headers: { location: '../final' } });
    return new Response('ok', { status: 200 });
  };
  const res = await safeFetch('https://8.8.8.8/a/b/hook', {}, { fetchImpl: stub });
  assert.equal(res.status, 200);
  assert.deepEqual(urls, ['https://8.8.8.8/a/b/hook', 'https://8.8.8.8/a/final']);
});

test('safeFetch: 无限重定向不会打到打不完，超过上限即报错', async () => {
  let called = 0;
  const stub = async () => { called++; return new Response(null, { status: 302, headers: { location: '/loop' } }); };
  await assert.rejects(() => safeFetch('https://8.8.8.8/loop', {}, { fetchImpl: stub }), /too many redirects/);
  assert.equal(called, 4); // 首跳 + 最多 3 次跟随
});

test('safeFetch: allowHost 限制每一跳都必须在白名单内', async () => {
  const stub = async () => new Response(null, { status: 302, headers: { location: 'https://8.8.4.4/x' } });
  await assert.rejects(
    () => safeFetch('https://lain.bgm.tv/a.jpg', {}, { fetchImpl: stub, allowHost: (h) => /(^|\.)bgm\.tv$/i.test(h) }),
    /blocked host/);
});

test('safeFetch: 非 http(s) 协议与非法 URL 直接拒绝', async () => {
  const stub = async () => new Response(null, { status: 200 });
  await assert.rejects(() => safeFetch('file:///etc/passwd', {}, { fetchImpl: stub }), /blocked protocol|bad url/);
  await assert.rejects(() => safeFetch('data:text/html,<h1>x', {}, { fetchImpl: stub }), /blocked protocol|bad url/);
  await assert.rejects(() => safeFetch('', {}, { fetchImpl: stub }), /bad url/);
});
