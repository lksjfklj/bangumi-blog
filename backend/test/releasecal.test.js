// releasecal.test.js - Galgame 新作发售日历管道集成测试（打桩 vndb.apiPost / notify，不真连外网）
// 数据流：扫 VNDB 发售窗口 -> upsert vndb_release_calendar -> 对齐 library_source_map 标 bgm_id -> digest 速报
// 注意：与其他测试共用本地开发库；使用独立假 ID 段，且不动 library_subjects，避免干扰 enrich/vndbStatus 统计。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// 先加载真实模块再打桩网络/通知层（releasecal 运行时动态读取 vndb.apiPost / notify.notify，同一 exports 对象）
const vndb = require('../src/vndb');
const notify = require('../src/notify');
const releasecal = require('../src/releasecal');
const { pool } = require('../src/db');

const STATE_KEY = 'release_cal_state';
const FAKE_IDS = ['v90101', 'v90102', 'v90103', 'v90104'];
const BGM_ID = 90000201; // 只写 library_source_map 行做对齐（无 library_subjects），不影响 vndbStatus 候选数
const q = (sql, p = []) => pool.query(sql, p)[0];

function mkVn(id, released, extra = {}) {
  return {
    id, title: extra.title || ('Fake VN ' + id),
    titles: extra.titles || [],
    released,
    olang: extra.olang || 'ja',
    developers: extra.developers || [{ name: 'FakeDev' }],
    platforms: extra.platforms || ['win', 'psv'],
    image: extra.image || { url: 'https://t.vndb.org/sf/00/' + id + '.jpg' },
    rating: extra.rating || 75,
    votecount: extra.votecount || 100,
    popularity: extra.popularity || 60,
    length: extra.length || 30
  };
}

const origApiPost = vndb.apiPost;
const origNotify = notify.notify;
let lastBody = null;       // 最近一次 apiPost 请求体（校验 filters/fields）
let pagesByCall = [];      // 按调用顺序返回的假分页
let notifyCalls = [];

before(async () => {
  const today = releasecal.todayStr();
  // 清掉可能存在的同窗口行，保证断言确定性
  await pool.query('DELETE FROM vndb_release_calendar WHERE released BETWEEN ? AND ?',
    [releasecal.addDays(today, -61), releasecal.addDays(today, 46)]);
  for (const id of FAKE_IDS) await pool.query('DELETE FROM vndb_release_calendar WHERE vndb_id = ?', [id]);
  await pool.query("DELETE FROM library_source_map WHERE bgm_id = ? AND source = 'vndb'", [BGM_ID]);
  await pool.query('DELETE FROM settings WHERE key = ?', [STATE_KEY]);
  await pool.query(
    `INSERT INTO library_source_map (bgm_id, source, source_id, status, match_score, checked_at, updated_at)
     VALUES (?, 'vndb', 'v90101', 'ok', 1, ?, ?)`,
    [BGM_ID, Date.now(), Date.now()]
  );
  vndb.apiPost = async (type, body) => {
    lastBody = body;
    return pagesByCall.shift() || { results: [], more: false };
  };
  notify.notify = async (title, body) => { notifyCalls.push({ title, body }); return true; };
});

after(async () => {
  vndb.apiPost = origApiPost;
  notify.notify = origNotify;
  for (const id of FAKE_IDS) await pool.query('DELETE FROM vndb_release_calendar WHERE vndb_id = ?', [id]);
  await pool.query("DELETE FROM library_source_map WHERE bgm_id = ? AND source = 'vndb'", [BGM_ID]);
  await pool.query('DELETE FROM settings WHERE key = ?', [STATE_KEY]);
});

test('纯函数: todayStr 按 UTC+8、addDays 跨月、dateLabel 当年省略年份、pickTitle 中文优先', () => {
  assert.equal(releasecal.todayStr(new Date('2026-09-03T16:30:00Z')), '2026-09-04'); // UTC+8 跨日
  assert.equal(releasecal.todayStr(new Date('2026-09-03T02:00:00Z')), '2026-09-03');
  assert.equal(releasecal.addDays('2026-08-31', 4), '2026-09-04');
  assert.equal(releasecal.addDays('2026-09-04', -10), '2026-08-25');
  assert.equal(releasecal.dateLabel('2026-09-04', '2026-09-03'), '9月4日');
  assert.equal(releasecal.dateLabel('2025-12-31', '2026-09-03'), '2025年12月31日');
  assert.equal(releasecal.dateLabel('', '2026-09-03'), '');
  const t = releasecal.pickTitle([
    { lang: 'ja', title: 'ひらがなタイトル' },
    { lang: 'zh-Hant', title: '繁體中文' },
    { lang: 'zh-Hans', title: '简体中文' },
    { lang: 'en', latin: 'Romaji Title' }
  ], 'Fallback');
  assert.equal(t.native, '简体中文');   // zh-Hans 优先
  assert.equal(t.latin, 'Romaji Title');
  assert.equal(t.display, '简体中文');
  const t2 = releasecal.pickTitle([{ lang: 'ja', title: '日本語' }], 'Main');
  assert.equal(t2.native, '日本語');
  assert.equal(t2.display, '日本語');
  const t3 = releasecal.pickTitle([], 'Main');
  assert.equal(t3.display, 'Main');
});

test('scanOnce: 增量窗口请求 + 语言过滤 + 幂等 upsert + 库内 bgm 对齐', async () => {
  const today = releasecal.todayStr();
  const scanRows = [
    mkVn('v90101', releasecal.addDays(today, -5), {
      title: 'CLANNAD', olang: 'ja', votecount: 999,
      titles: [{ lang: 'zh-Hans', title: '团子大家族' }],
      developers: [{ name: 'Key' }]
    }),
    mkVn('v90102', releasecal.addDays(today, 10), { olang: 'zh-Hans' }),
    mkVn('v90103', releasecal.addDays(today, 3), { olang: 'en' }), // 欧美 VN：应被过滤
    mkVn('v90104', releasecal.addDays(today, -2), { olang: 'ja' })  // 近 4 天发售：digest 候选
  ];
  pagesByCall = [{ results: scanRows, more: false }];
  const res = await releasecal.scanOnce({ digest: false });
  assert.equal(res.ok, true);
  assert.equal(res.stats.pages, 1);
  assert.equal(res.stats.fetched, 3);  // en 行被过滤
  assert.equal(res.stats.saved, 3);
  assert.equal(q('SELECT COUNT(*) AS n FROM vndb_release_calendar WHERE vndb_id = ?', ['v90103'])[0].n, 0);
  // 请求体：窗口 + 核心原语种过滤 + 分页字段
  assert.ok(Array.isArray(lastBody.filters));
  const f = JSON.stringify(lastBody.filters);
  assert.ok(f.includes('"released"') && f.includes('"olang"'));
  assert.equal(lastBody.sort, 'released');
  // 落库字段
  const row = q('SELECT * FROM vndb_release_calendar WHERE vndb_id = ?', ['v90101'])[0];
  assert.equal(row.released, releasecal.addDays(today, -5));
  assert.equal(row.olang, 'ja');
  assert.equal(row.votecount, 999);
  assert.equal(JSON.parse(row.titles)[0].title, '团子大家族');
  assert.equal(JSON.parse(row.developers)[0], 'Key');
  // 幂等：再扫一次不产生重复行、count 不变（同源数据再次 upsert）
  pagesByCall = [{ results: scanRows, more: false }];
  const res2 = await releasecal.scanOnce({ digest: false });
  assert.equal(res2.ok, true);
  assert.equal(res2.stats.saved, 3);
  assert.equal(q('SELECT COUNT(*) AS n FROM vndb_release_calendar WHERE vndb_id IN (?,?,?,?)', FAKE_IDS)[0].n, 3);
});

test('getCalendar: recent/upcoming 分类、语言/日期文本、bgmId 库内标记', async () => {
  const cal = await releasecal.getCalendar({ recentDays: 30, upcomingDays: 45, limit: 20 });
  assert.equal(cal.source, 'vndb');
  const rec = cal.recent.find(x => x.vndbId === 'v90101');
  assert.ok(rec, '近 5 天发售应出现在 recent');
  assert.equal(rec.title, '团子大家族');   // display = 中文原生
  assert.equal(rec.bgmId, BGM_ID);
  assert.equal(rec.inLibrary, true);
  assert.equal(rec.langLabel, '日语');
  assert.ok(rec.dateText.includes('月') && rec.dateText.includes('日'));
  assert.equal(rec.vndbUrl, 'https://vndb.org/v90101');
  const up = cal.upcoming.find(x => x.vndbId === 'v90102');
  assert.ok(up, '未来定档应出现在 upcoming');
  assert.equal(up.inLibrary, false);
  assert.equal(up.bgmId, 0);
  // en 行不应出现在任何列表
  assert.ok(!cal.recent.some(x => x.vndbId === 'v90103'));
  assert.ok(!cal.upcoming.some(x => x.vndbId === 'v90103'));
});

test('digest 新作速报: 近 4 天发售触发 notify 并标记 seen（之后不再重复推送）', async () => {
  notifyCalls.length = 0;
  await pool.query('UPDATE vndb_release_calendar SET seen = 0'); // 模拟刚回填
  pagesByCall = []; // 无新页，仅走 digest 逻辑
  const res = await releasecal.scanOnce({ digest: true });
  assert.equal(res.ok, true);
  assert.equal(res.digest.sent, true);
  assert.equal(res.digest.count, 1); // 只有 v90104（-2 天）在近 4 天窗口
  assert.equal(notifyCalls.length, 1);
  assert.ok(notifyCalls[0].title.includes('新作速报'));
  assert.ok(notifyCalls[0].body.includes('Fake VN v90104'));
  // 窗口内已全部标记 seen；再跑一轮 digest 不重复推送
  assert.equal(q('SELECT COUNT(*) AS n FROM vndb_release_calendar WHERE seen = 0 AND released BETWEEN ? AND ?',
    [releasecal.addDays(releasecal.todayStr(), -4), releasecal.todayStr()])[0].n, 0);
  notifyCalls.length = 0;
  pagesByCall = [];
  const res2 = await releasecal.scanOnce({ digest: true });
  assert.equal(res2.digest.count, 0);
  assert.equal(notifyCalls.length, 0);
  // 状态接口汇总可见
  const st = await releasecal.getStatus();
  assert.equal(st.module, 'releasecal');
  assert.ok(st.summary.total >= 3);
  assert.ok(st.summary.matched >= 1);
});
