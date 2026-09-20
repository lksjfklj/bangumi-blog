// browser.test.js - 番剧库筛选参数 -> bgm.tv 抓取路径 / 缓存键
// 背景：bgm.tv 没有可用的 query 参数版筛选（实测 ?year=/?airtime= 一律被忽略），
// 而且官网的 /anime/browser/airtime/<年> 会被 Cloudflare 人机校验拦成 403，只能走等价标签。
// 早期实现只在 tag 同时存在时才拼 airtime 段，于是单独传 year（手编 URL）被静默丢弃：
// 用户以为按年份筛过了，实际看到的还是全库榜单。这里把规则钉死。
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBrowserPlan, browserListPath, browserCacheKey, browserEndCacheKey, safeTag } = require('../src/browserplan');

test('无筛选：走全库榜单，缓存键与旧格式保持兼容', () => {
  const plan = buildBrowserPlan({ sort: 'trends' });
  assert.deepEqual(plan, { sort: 'trends', tag: '', period: '', filtered: false });
  assert.equal(browserListPath(plan, 3), '/anime/browser?sort=trends&page=3');
  assert.equal(browserCacheKey(plan, 1), 'bgm:browser:trends:-:-:1');
  assert.equal(browserEndCacheKey(plan), 'bgm:browser:end:-:-');
});

test('排序白名单：非法值/数组/缺省一律回落 trends', () => {
  for (const s of ['', null, undefined, 'rank"on', 'TRENDS', ['trends'], 'trends&page=99']) {
    assert.equal(buildBrowserPlan({ sort: s }).sort, 'trends');
  }
  assert.equal(buildBrowserPlan({ sort: 'rank' }).sort, 'rank');
  assert.equal(buildBrowserPlan({ sort: 'title' }).sort, 'title');
});

test('单独年份：必须真的按年份筛（走年份标签），不能退化成全库榜单', () => {
  const plan = buildBrowserPlan({ sort: 'trends', year: '2024' });
  assert.equal(plan.filtered, true);
  assert.equal(plan.tag, '2024年');
  assert.equal(plan.period, '');
  const url = browserListPath(plan, 1);
  assert.equal(url, '/anime/tag/2024%E5%B9%B4?sort=trends&page=1');
  assert.doesNotMatch(url, /\/anime\/browser\?/);
  // 与全库、与其它年份都不能共用缓存键
  assert.notEqual(browserCacheKey(plan, 1), browserCacheKey(buildBrowserPlan({ sort: 'trends' }), 1));
  assert.notEqual(browserCacheKey(plan, 1), browserCacheKey(buildBrowserPlan({ sort: 'trends', year: '2023' }), 1));
  assert.equal(browserCacheKey(plan, 1), 'bgm:browser:trends:2024年:-:1');
});

test('年份 + 类型标签：叠加成 bgm 的 /airtime/<年份>，顺序与分页正确', () => {
  const plan = buildBrowserPlan({ sort: 'rank', tag: '科幻', year: '2024' });
  assert.deepEqual(plan, { sort: 'rank', tag: '科幻', period: '2024', filtered: true });
  assert.equal(browserListPath(plan, 2), '/anime/tag/%E7%A7%91%E5%B9%BB/airtime/2024?sort=rank&page=2');
  assert.equal(browserCacheKey(plan, 2), 'bgm:browser:rank:科幻:2024:2');
});

test('只给标签：不拼 airtime 段（拼了会变成「标签 + 空年份」的无效组合）', () => {
  const plan = buildBrowserPlan({ sort: 'trends', tag: '日常' });
  assert.equal(plan.tag, '日常');
  assert.equal(plan.period, '');
  assert.equal(browserListPath(plan, 1), '/anime/tag/%E6%97%A5%E5%B8%B8?sort=trends&page=1');
});

test('季度最具体且独占：同时传标签/年份也只按季度筛', () => {
  const plan = buildBrowserPlan({ sort: 'trends', airtime: '2026-7', tag: '科幻', year: '2024' });
  assert.deepEqual(plan, { sort: 'trends', tag: '2026年7月', period: '', filtered: true });
  assert.equal(browserListPath(plan, 1), '/anime/tag/2026%E5%B9%B47%E6%9C%88?sort=trends&page=1');
  // 与「7 月」以外的季度、与同月不同年都不能串
  assert.notEqual(browserCacheKey(plan, 1), browserCacheKey(buildBrowserPlan({ sort: 'trends', airtime: '2026-4' }), 1));
  assert.notEqual(browserCacheKey(plan, 1), browserCacheKey(buildBrowserPlan({ sort: 'trends', airtime: '2025-7' }), 1));
});

test('季度格式非法时不参与筛选，剩余参数照常生效', () => {
  for (const bad of ['2026', '2026-13', '2026-0', 'abc', '2026-07-01', '']) {
    const plan = buildBrowserPlan({ sort: 'trends', airtime: bad, year: '2024' });
    assert.equal(plan.tag, '2024年', 'airtime=' + bad);
  }
  // 季度非法 + 标签 + 年份 -> 退化成 标签+年份
  const plan = buildBrowserPlan({ sort: 'trends', airtime: 'oops', tag: '科幻', year: '2024' });
  assert.deepEqual(plan, { sort: 'trends', tag: '科幻', period: '2024', filtered: true });
});

test('季度标签：0 填充的月份也要归一成「7月」而不是「07月」', () => {
  assert.equal(buildBrowserPlan({ airtime: '2026-07' }).tag, '2026年7月');
  assert.equal(buildBrowserPlan({ airtime: '2026-7' }).tag, '2026年7月');
  assert.equal(buildBrowserPlan({ airtime: '2026-12' }).tag, '2026年12月');
});

// safeTag：筛选词校验。旧实现是路由里的窄字符白名单（中日汉字/字母数字/空格/-/_/·/+，限 20 字），
// 实测本地库 9571 个标签里有 1641 个（17%）过不了，会被静默丢成「不过滤」——
// 卡片标签点进来变成全库列表，用户看到的就是「点了没反应」。
test('safeTag: 放行真实标签里出现过的片假名/长符号/破折号/书名号，不再静默丢弃', () => {
  for (const t of ['週刊少年ジャンプ', 'コミックス', 'ガガガ文庫', '葵せきな', '大場つぐみ',
    '轻小说（单行本）', '★マンガ', '7.5', '小说—分卷', '【系列】', '『漫画』', '¬', '科幻']) {
    assert.equal(safeTag(t), t, t);
  }
  // 0 填充季节标签这类会进 URL 的值同样要放行
  assert.equal(safeTag('2026年7月'), '2026年7月');
});

test('safeTag: 控制字符一律拒绝，超长截断为空，首尾空白去掉', () => {
  assert.equal(safeTag(''), '');
  assert.equal(safeTag(null), '');
  assert.equal(safeTag(undefined), '');
  assert.equal(safeTag('   '), '');
  assert.equal(safeTag('  科幻  '), '科幻');
  // 换行/回车/Tab/空字节：拼进 bgm 抓取路径或日志都会出事，直接判非法
  for (const bad of ['科\n幻', '科\r幻', '科\t幻', '科幻\u0000', '科\u0007幻', '科幻\u009b']) {
    assert.equal(safeTag(bad), '', JSON.stringify(bad));
  }
  // 限长 40 字（按码点算，不能让 emoji/代理对把长度算成两倍）；库里最长标签 30 字
  assert.equal(safeTag('あ'.repeat(40)), 'あ'.repeat(40));
  assert.equal(safeTag('あ'.repeat(41)), '');
  assert.equal(safeTag('🈚'.repeat(40)), '🈚'.repeat(40));
  assert.equal(safeTag('🈚'.repeat(41)), '');
});

test('safeTag: 危险字符交给 encodeURIComponent 兜底，不靠白名单拦', () => {
  // 斜杠/问号/井号不能原样进路径，但 encodeURIComponent 会转义，因此 safeTag 放行、路径仍然安全
  const plan = buildBrowserPlan({ sort: 'trends', tag: safeTag('../a?b#c') });
  const url = browserListPath(plan, 1);
  assert.doesNotMatch(url, /\?sort=trends&page=1&/);      // 没有多出来的参数
  assert.equal(url, '/anime/tag/..%2Fa%3Fb%23c?sort=trends&page=1');
  // 缓存键按原值区分，不会和别的筛选串数据
  assert.equal(browserCacheKey(plan, 1), 'bgm:browser:trends:../a?b#c:-:1');
});

test('末页探测缓存键按筛选条件区分，页面缓存键按排序区分', () => {
  const a = buildBrowserPlan({ sort: 'trends', year: '2024' });
  const b = buildBrowserPlan({ sort: 'rank', year: '2024' });
  assert.equal(browserEndCacheKey(a), browserEndCacheKey(b)); // 末页与排序无关，可复用
  assert.notEqual(browserCacheKey(a, 1), browserCacheKey(b, 1)); // 榜单内容与排序有关，必须分开
  assert.notEqual(browserCacheKey(a, 1), browserCacheKey(a, 2)); // 每页各自缓存
});
