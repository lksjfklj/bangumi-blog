// bookrelease.test.js - 漫画/轻小说 新作发售日历管道集成测试（打桩 bangumi.bgm，不真连外网）
// 数据流：扫 Bangumi type=1 sort=date 流（offset 游标）-> 平台分类（漫画/小说）-> upsert 窗口内行
//        -> getCalendar 分 recent/upcoming -> 与 library_subjects 对齐标 in_library
// 注意：与其他测试共用本地开发库；使用独立假 ID 段（>= 900200000），且只动本模块自己的表。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { initDb, pool } = require('../src/db');
initDb();

const bangumi = require('../src/bangumi');
const bookrelease = require('../src/bookrelease');
const { todayStr, addDays } = bookrelease;

const STATE_KEY = 'bgm_book_release_cal_state';
const ID_BASE = 900200000;
// 「最新一卷」回写测试用的独立假 ID 段（不与 90000101 / 900200xxx 等其它测试段冲突）
const LATEST_ID_BASE = 900300001;
const q = (sql, p = []) => pool.query(sql, p)[0];

const today = todayStr();
const from = addDays(today, -60);   // 与 bookrelease WINDOW_BACK_DAYS 一致
const to = addDays(today, 45);      // 与 bookrelease WINDOW_FORWARD_DAYS 一致

// 构造有序假流：date 倒序（未来 -> 过去），每天 漫画/小说/画集 各 1 条；画集不入日历
const STREAM = [];
const byKey = {};
let idSeed = ID_BASE;
function push(date, platform, extra = {}) {
  const id = ++idSeed;
  const item = {
    id, name: 'TestTitle' + id, name_cn: extra.cn || ('测试标题' + id),
    date, platform, meta_tags: [],
    rating: { score: extra.score || 7.5, total: extra.total || 12, rank: 0 },
    images: { common: 'https://lain.bgm.tv/pic/cover/' + id + '.jpg' }
  };
  STREAM.push(item);
  byKey[date + '|' + platform] = id;
  return item;
}
for (let d = 70; d >= -80; d--) {
  const date = addDays(today, d);
  push(date, '漫画');
  push(date, '小说');
  push(date, '画集');
}
// 无日期行（末尾，扫描通常在窗口左界提前停，不构成影响）
for (let i = 0; i < 3; i++) push('', '漫画');

const inWindowDays = 45 - (-60) + 1; // 106
const EXPECT_SAVED = inWindowDays * 2; // 每天 漫画+小说
const LN_TEST_ID = byKey[addDays(today, -5) + '|小说']; // 入库对齐测试用
const origBgm = bangumi.bgm;
let reqCount = 0;

before(async () => {
  await pool.query('DELETE FROM bgm_book_release_calendar WHERE subject_id >= ?', [ID_BASE]);
  await pool.query('DELETE FROM library_subjects WHERE subject_id = ? AND category = ?', [LN_TEST_ID, 'lightnovel']);
  await pool.query('DELETE FROM settings WHERE key = ?', [STATE_KEY]);
  bangumi.bgm = async (url) => {
    reqCount++;
    const m = String(url || '').match(/offset=(\d+)/);
    const offset = m ? +m[1] : 0;
    return { data: STREAM.slice(offset, offset + 50), total: STREAM.length };
  };
});

after(async () => {
  bangumi.bgm = origBgm;
  await pool.query('DELETE FROM bgm_book_release_calendar WHERE subject_id >= ?', [ID_BASE]);
  await pool.query('DELETE FROM library_subjects WHERE subject_id = ? AND category = ?', [LN_TEST_ID, 'lightnovel']);
  await pool.query('DELETE FROM library_subjects WHERE subject_id >= ?', [LATEST_ID_BASE]);
  await pool.query('DELETE FROM settings WHERE key = ?', [STATE_KEY]);
});

test('纯函数: todayStr UTC+8、addDays 跨月、dateLabel、classifyPlatform', () => {
  assert.equal(bookrelease.todayStr(new Date('2026-09-03T16:30:00Z')), '2026-09-04');
  assert.equal(bookrelease.todayStr(new Date('2026-09-03T02:00:00Z')), '2026-09-03');
  assert.equal(bookrelease.addDays('2026-08-31', 4), '2026-09-04');
  assert.equal(bookrelease.dateLabel('2026-09-04', '2026-09-03'), '9月4日');
  assert.equal(bookrelease.dateLabel('2025-12-31', '2026-09-03'), '2025年12月31日');
  assert.equal(bookrelease.classifyPlatform('漫画'), 'manga');
  assert.equal(bookrelease.classifyPlatform('小说'), 'lightnovel');
  assert.equal(bookrelease.classifyPlatform('画集'), null);
  assert.equal(bookrelease.classifyPlatform(''), null);
});

test('scanOnce: 窗口内 漫画/小说 幂等 upsert，画集/越界日期跳过', async () => {
  reqCount = 0;
  const res = await bookrelease.scanOnce({});
  assert.equal(res.ok, true);
  assert.equal(res.stats.pages >= 8, true, '应翻至少 8 页');
  assert.equal(res.stats.saved, EXPECT_SAVED);
  assert.equal(q('SELECT COUNT(*) AS n FROM bgm_book_release_calendar')[0].n, EXPECT_SAVED);
  // 分类落库正确
  const manga = q('SELECT COUNT(*) AS n FROM bgm_book_release_calendar WHERE category = ?', ['manga'])[0].n;
  const ln = q('SELECT COUNT(*) AS n FROM bgm_book_release_calendar WHERE category = ?', ['lightnovel'])[0].n;
  assert.equal(manga, inWindowDays);
  assert.equal(ln, inWindowDays);
  // 画集平台不应入库
  assert.equal(q('SELECT COUNT(*) AS n FROM bgm_book_release_calendar WHERE platform = ?', ['画集'])[0].n, 0);
  // 字段抽查
  const row = q('SELECT * FROM bgm_book_release_calendar WHERE subject_id = ?', [byKey[addDays(today, 3) + '|小说']])[0];
  assert.equal(row.date, addDays(today, 3));
  assert.equal(row.platform, '小说');
  assert.ok(String(row.image).includes('lain.bgm.tv'));
  // 状态已写
  const st = q('SELECT value FROM settings WHERE key = ?', [STATE_KEY]);
  assert.ok(st.length && JSON.parse(st[0].value).lastRunAt);
  // 幂等：再扫一遍行数不变
  const res2 = await bookrelease.scanOnce({});
  assert.equal(res2.ok, true);
  assert.equal(q('SELECT COUNT(*) AS n FROM bgm_book_release_calendar')[0].n, EXPECT_SAVED);
});

test('getCalendar: manga/lightnovel recent/upcoming 分窗、库内对齐、字段形状', async () => {
  // 给一条轻小说造本地库行，验证 inLibrary 标记
  await pool.query(
    `INSERT INTO library_subjects (subject_id, category, name, name_cn, image, air_date, rating_score, rating_total, rank, platform, updated_at)
     VALUES (?, 'lightnovel', ?, ?, '', ?, 0, 0, 0, '小说', ?)`,
    [LN_TEST_ID, 'TestTitle' + LN_TEST_ID, '测试标题' + LN_TEST_ID, addDays(today, -5), Date.now()]
  );
  const manga = await bookrelease.getCalendar({ category: 'manga', recentDays: 30, upcomingDays: 45, limit: 20 });
  assert.equal(manga.source, 'bangumi');
  assert.equal(manga.category, 'manga');
  assert.equal(manga.recentTotal, 31);  // 今天+过去29天=30天窗口 -> 每天1部
  assert.equal(manga.upcomingTotal, 45);
  const it = manga.recent[0];
  assert.ok(it.bgmId > 0);
  assert.ok(it.dateText.includes('月') && it.dateText.includes('日'));
  assert.equal(it.langLabel, '漫画');
  assert.equal(it.developers.length, 0);
  assert.ok(it.image.startsWith('https://'));
  assert.equal(it.rating > 0, true);
  // upcoming 全部晚于今天
  for (const u of manga.upcoming) assert.ok(String(u.date) > today);
  // 轻小说窗口 + 库内标记
  const ln = await bookrelease.getCalendar({ category: 'lightnovel', limit: 30 });
  assert.equal(ln.category, 'lightnovel');
  const hit = ln.recent.find(x => x.bgmId === LN_TEST_ID);
  assert.ok(hit, '轻小说近 30 天应包含测试行');
  assert.equal(hit.inLibrary, true);
  assert.equal(hit.langLabel, '轻小说');
  const miss = ln.recent.find(x => x.bgmId !== LN_TEST_ID);
  assert.equal(miss.inLibrary, false);
  // 未知 category 归一为 manga
  const def = await bookrelease.getCalendar({ category: 'unknown' });
  assert.equal(def.category, 'manga');
});

test('getStatus: 汇总可见', async () => {
  const st = await bookrelease.getStatus();
  assert.equal(st.module, 'bookrelease');
  assert.ok(st.summary.total >= EXPECT_SAVED);
  assert.ok(st.summary.manga >= inWindowDays);
  assert.ok(st.summary.lightnovel >= inWindowDays);
  assert.ok(st.summary.upcoming >= 45);
  assert.ok(st.lastRunAt);
});

// ---------- 「最新一卷」日期回写（syncLatestDates） ----------
// 语义：日历窗口里每一行 = 一次新卷登载，把它按「剥掉卷号后的系列名（原名/中文名）」或「subject_id 直连」
//       匹配回库内条目并写进 latest_date（供 library.js 的 sort=trends 排序），只增不减。
const S_ID = LATEST_ID_BASE;         // 库内系列主体，靠「剥卷号后的名字」命中
const S_DIRECT = LATEST_ID_BASE + 1; // 库内条目，靠 subject_id 直连命中
const S_CN = LATEST_ID_BASE + 2;     // 库内条目，靠中文名命中

async function insLib(id, name, nameCn, airDate, latest) {
  await pool.query(
    `INSERT INTO library_subjects (subject_id, category, name, name_cn, image, air_date, rating_score, rating_total, rank, platform, tags, regions, latest_date, blocked, updated_at)
     VALUES (?, 'manga', ?, ?, '', ?, 7.5, 10, 0, '漫画', '[]', '[]', ?, 0, ?)
     ON CONFLICT(subject_id, category) DO UPDATE SET
       name = excluded.name, name_cn = excluded.name_cn, air_date = excluded.air_date,
       latest_date = excluded.latest_date, updated_at = excluded.updated_at`,
    [id, name, nameCn, airDate, latest, Date.now()]);
}
// 带分类的库内条目写入（跨分类隔离测试用：同名同系列分别收在 manga / lightnovel）
async function insLibCat(id, category, name, nameCn, airDate, latest) {
  await pool.query(
    `INSERT INTO library_subjects (subject_id, category, name, name_cn, image, air_date, rating_score, rating_total, rank, platform, tags, regions, latest_date, blocked, updated_at)
     VALUES (?, ?, ?, ?, '', ?, 7.5, 10, 0, '书籍', '[]', '[]', ?, 0, ?)
     ON CONFLICT(subject_id, category) DO UPDATE SET
       name = excluded.name, name_cn = excluded.name_cn, air_date = excluded.air_date,
       latest_date = excluded.latest_date, updated_at = excluded.updated_at`,
    [id, category, name, nameCn, airDate, latest, Date.now()]);
}
async function insCal(id, category, name, nameCn, date) {
  await pool.query(
    `INSERT INTO bgm_book_release_calendar (subject_id, category, name, name_cn, image, date, platform, rating_score, rating_total, rank, meta_tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, '漫画', 0, 0, 0, '[]', ?, ?)
     ON CONFLICT(subject_id) DO UPDATE SET category = excluded.category, name = excluded.name,
       name_cn = excluded.name_cn, date = excluded.date, updated_at = excluded.updated_at`,
    [id, category, name, nameCn, date, Date.now(), Date.now()]);
}

test('syncLatestDates: 系列名（原名/中文名）与 id 直连两路命中、多行取最新、只增不减', async () => {
  await pool.query('DELETE FROM library_subjects WHERE subject_id >= ?', [LATEST_ID_BASE]);
  await pool.query('DELETE FROM bgm_book_release_calendar WHERE subject_id >= ?', [LATEST_ID_BASE]);
  await insLib(S_ID, 'テスト最新卷シリーズ', '测试最新卷系列', '1990-01-01', '');
  await insLib(S_DIRECT, '月間ダイレクトテスト', '月刊直连测试', '1990-01-01', '');
  await insLib(S_CN, 'テスト中文シリーズ', '测试中文系列', '1990-01-01', '');
  const v3 = addDays(today, -20);
  const v5 = addDays(today, 10);
  await insCal(LATEST_ID_BASE + 10, 'manga', 'テスト最新卷シリーズ (3)', '', v3);
  await insCal(LATEST_ID_BASE + 11, 'manga', 'テスト最新卷シリーズ (5)', '', v5);
  // id 直连：这条日历行的名字剥不出系列名，只能靠 subject_id 对上
  await insCal(S_DIRECT, 'manga', '月間ダイレクトテスト 別巻', '', addDays(today, -3));
  // 中文名路：原名对不上、中文名剥掉卷号后能对上
  await insCal(LATEST_ID_BASE + 12, 'manga', 'テスト中文シリーズ・完全版', '测试中文系列 第2巻', addDays(today, -2));

  const res = await bookrelease.syncLatestDates();
  assert.equal(res.ok, true);
  assert.ok(res.updated >= 3, '至少三条应被回写，实际 ' + res.updated);
  const got = (id) => q('SELECT latest_date FROM library_subjects WHERE subject_id = ?', [id])[0].latest_date;
  assert.equal(got(S_ID), v5, '同一系列多行命中时取最晚的一卷');
  assert.equal(got(S_DIRECT), addDays(today, -3), 'subject_id 直连命中');
  assert.equal(got(S_CN), addDays(today, -2), '中文名剥卷号后命中');

  // 只增不减：补一条更早的旧卷、再把库内值改成更晚的日期，重跑都不许回退
  await insCal(LATEST_ID_BASE + 13, 'manga', 'テスト最新卷シリーズ 第1巻', '', addDays(today, -400));
  const res2 = await bookrelease.syncLatestDates();
  assert.equal(res2.ok, true);
  assert.equal(got(S_ID), v5, '重扫旧卷不能冲掉已记录的新卷日期');
  await pool.query('UPDATE library_subjects SET latest_date = ? WHERE subject_id = ?', [addDays(today, 300), S_ID]);
  await bookrelease.syncLatestDates();
  assert.equal(got(S_ID), addDays(today, 300), '库里已是更晚的日期时不许回退');

  // 状态快照可见（管理页/诊断用）
  const st = await bookrelease.getStatus();
  assert.ok(st.latestRefresh && st.latestRefresh.at);
  assert.ok(st.latestRefresh.library >= 3);
});

// ---------- 分类隔离 / 历史污染纠错 ----------
// 回归：bgm 里同一系列常常漫画/小说双栖（安達としまむら、お隣の天使様…），系列名归一化后是同一个键。
// 老实现 byKey 不按 category 分桶，漫画日历行的发售日会被写进同名轻小说条目（线上实测 150+ 条）。
const X_ID = LATEST_ID_BASE + 200;    // 轻小说侧
const X_MANGA = LATEST_ID_BASE + 201; // 漫画侧
const C_LN = LATEST_ID_BASE + 210;    // 被跨分类污染、同分类有真值
const C_LN2 = LATEST_ID_BASE + 211;   // 被跨分类污染、同分类无真值

test('syncLatestDates: 漫画日历行不会写进同名轻小说条目（分类隔离）', async () => {
  await pool.query('DELETE FROM library_subjects WHERE subject_id IN (?, ?, ?)', [X_ID, X_MANGA, C_LN]);
  await insLibCat(X_ID, 'lightnovel', 'クロス分類テスト', '跨分类隔离测试', '1990-01-01', '');
  await insLibCat(X_MANGA, 'manga', 'クロス分類テスト', '跨分类隔离测试', '1990-01-01', '');
  const d = addDays(today, 20);
  await insCal(LATEST_ID_BASE + 220, 'manga', 'クロス分類テスト (7)', '', d);

  const res = await bookrelease.syncLatestDates();
  assert.equal(res.ok, true);
  const latest = (id) => q('SELECT latest_date FROM library_subjects WHERE subject_id = ?', [id])[0].latest_date;
  assert.equal(latest(X_MANGA), d, '同分类（漫画）条目应被回写');
  assert.ok(!latest(X_ID), '异分类（轻小说）条目不许被写');

  // 反向：轻小说日历行也只写轻小说，不写漫画
  const d2 = addDays(today, 25);
  await insCal(LATEST_ID_BASE + 221, 'lightnovel', 'クロス分類テスト (3)', '', d2);
  await bookrelease.syncLatestDates();
  assert.equal(latest(X_ID), d2, '轻小说日历行应回写轻小说条目');
  assert.equal(latest(X_MANGA), d, '漫画条目不该被轻小说行改写');
});

test('syncLatestDates: 历史跨分类污染会被纠正（同分类有真值则改写，否则清空）', async () => {
  await pool.query('DELETE FROM library_subjects WHERE subject_id IN (?, ?)', [C_LN, C_LN2]);
  const crossDay = addDays(today, 30);
  const rightDay = addDays(today, -10);
  const crossDay2 = addDays(today, 40);
  // C_LN：现值 = 漫画日历行的日期（跨分类污染），同分类日历有更早的真值 -> 应纠正成真值
  await insLibCat(C_LN, 'lightnovel', '汚染修正テスト', '污染修正测试', '1990-01-01', crossDay);
  await insCal(LATEST_ID_BASE + 230, 'manga', '汚染修正テスト (2)', '', crossDay);
  await insCal(LATEST_ID_BASE + 231, 'lightnovel', '汚染修正テスト (1)', '', rightDay);
  // C_LN2：现值只能由漫画行解释、同分类一行都没有 -> 应清空（宁可没有日期，也不能显示别的分类的日期）
  await insLibCat(C_LN2, 'lightnovel', '汚染清空テスト', '污染清空测试', '1990-01-01', crossDay2);
  await insCal(LATEST_ID_BASE + 232, 'manga', '汚染清空テスト (3)', '', crossDay2);

  const res = await bookrelease.syncLatestDates();
  assert.equal(res.ok, true);
  assert.ok(res.corrected >= 2, '应至少纠正两条跨分类污染，实际 ' + res.corrected);
  const latest = (id) => q('SELECT latest_date FROM library_subjects WHERE subject_id = ?', [id])[0].latest_date;
  assert.equal(latest(C_LN), rightDay, '同分类有真值时改成真值');
  assert.ok(!latest(C_LN2), '同分类无真值时清空');

  // 不误伤：日历解释不了的「库里更晚的日期」保持不动（可能是已滑出窗口的旧扫描留下的合法值）
  assert.equal(latest(S_ID), addDays(today, 300), '窗口外的合理新日期不许被当成污染清掉');
});