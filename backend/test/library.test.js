// library.test.js - 本地内容库分类器单测（书籍 classify / 游戏 classifyGame）
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { classify, classifyGame, regionsOf, queryLibrary } = require('../src/library');
const { initDb, pool } = require('../src/db');

initDb(); // 「近期注目」排序走真实 SQLite，这里直接在开发库上验排序语义

const mkBook = (platform, meta = [], tags = []) => ({
  platform,
  meta_tags: meta,
  tags: tags.map(n => ({ name: n }))
});
const mkGame = (meta = [], tags = []) => mkBook('游戏', meta, tags);
// 带名称的条目（命中 GALGAME_NAME_PATTERNS 系列名规则需要 name/name_cn）
const mkGameNamed = (name, nameCn, meta = [], tags = []) => ({
  name,
  name_cn: nameCn,
  platform: '游戏',
  meta_tags: meta,
  tags: tags.map(n => ({ name: n }))
});

test('classify: 平台=漫画 -> manga', () => {
  assert.equal(classify(mkBook('漫画', [], ['少年', '热血'])), 'manga');
});
test('classify: 平台=小说 且标签含轻小说 -> lightnovel', () => {
  assert.equal(classify(mkBook('小说', ['轻小说'], ['奇幻'])), 'lightnovel');
});
test('classify: 小说但无轻小说标签 / 其他平台 -> null', () => {
  assert.equal(classify(mkBook('小说', [], ['文库'])), null);
  assert.equal(classify(mkBook('游戏', ['视觉小说'])), null);
});

test('classifyGame: meta_tags 命中 Galgame / 视觉小说 / 乙女向 / BL / GL', () => {
  assert.equal(classifyGame(mkGame(['Galgame', '泣きゲー'], ['恋爱'])), 'galgame');
  assert.equal(classifyGame(mkGame(['视觉小说'], ['悬疑'])), 'galgame');
  assert.equal(classifyGame(mkGame(['乙女向'], [])), 'galgame');
  assert.equal(classifyGame(mkGame([], ['BL'])), 'galgame');
  assert.equal(classifyGame(mkGame([], ['GL'])), 'galgame');
});
test('classifyGame: 仅用户 tags 命中也算（补 meta 漏标）', () => {
  assert.equal(classifyGame(mkGame(['科幻'], ['Galgame', '剧情'])), 'galgame');
  assert.equal(classifyGame(mkGame(['科幻', 'game'], ['galgame'])), 'galgame');
});
test('classifyGame: 无视觉小说向标记且系列名不命中 -> null（P5/塞尔达等）', () => {
  assert.equal(classifyGame(mkGame(['游戏'], ['女神异闻录', 'RPG'])), null);
  assert.equal(classifyGame(mkGame([], ['冒险', '任天堂'])), null);
  assert.equal(classifyGame(mkGame(['悬疑'], ['推理'])), null);
  assert.equal(classifyGame(mkGame([], [])), null);
  // 名称含「兰斯」但不是系列（米兰斯纪事）/ 纯 RPG 开放世界（塞尔达）都不收
  assert.equal(classifyGame(mkGameNamed('米兰斯纪事 圣域传奇', '', ['RPG'], ['中国'])), null);
  assert.equal(classifyGame(mkGameNamed('ゼルダの伝説 ブレス オブ ザ ワイルド', '塞尔达传说 旷野之息', [], ['开放世界'])), null);
});

test('classifyGame: 无 Galgame 标签但系列名命中也收录（逆转裁判/兰斯）', () => {
  // 逆转裁判：被标成 AVG/推理，靠条目名收录（日文名 + 中文名各测一次）
  assert.equal(classifyGame(mkGameNamed('逆転裁判6', '逆转裁判6', ['AVG', '推理'], [])), 'galgame');
  assert.equal(classifyGame(mkGameNamed('', '大逆转裁判2 成步堂龙之介的觉悟', [], ['推理'])), 'galgame');
  // 逆转检事 / 英文名
  assert.equal(classifyGame(mkGameNamed('逆転検事2', '逆转检事2', [], [])), 'galgame');
  assert.equal(classifyGame(mkGameNamed('Ace Attorney 6', '', [], [])), 'galgame');
  // 兰斯：RPG/R18 标签不影响，按兰斯/ランス/Rance 开头命中
  assert.equal(classifyGame(mkGameNamed('ランス10', '兰斯10 决战', ['RPG', 'R18'], [])), 'galgame');
  assert.equal(classifyGame(mkGameNamed('', '兰斯01 寻找小光', [], ['RPG'])), 'galgame');
  assert.equal(classifyGame(mkGameNamed('鬼畜王ランス', '鬼畜王兰斯', [], ['SLG'])), 'galgame');
  assert.equal(classifyGame(mkGameNamed('Rance Quest', '兰斯8', [], [])), 'galgame');
});
test('classifyGame: 与 classify 互不干扰（平台=游戏 不进书籍分类）', () => {
  assert.equal(classify(mkGame(['Galgame'])), null);
});

test('classifyGame: 成人向标记（R18/18禁/eroge/黄油/エロゲー等）也收录', () => {
  assert.equal(classifyGame(mkGame(['R18', 'RPG'], ['SLG'])), 'galgame');
  assert.equal(classifyGame(mkGame(['R-18', 'AVG'], [])), 'galgame');
  assert.equal(classifyGame(mkGame([], ['18禁'])), 'galgame');
  assert.equal(classifyGame(mkGame([], ['eroge'])), 'galgame');
  assert.equal(classifyGame(mkGame(['エロゲー'], ['恋爱'])), 'galgame');
  assert.equal(classifyGame(mkGame(['黄油', 'HGAME'], [])), 'galgame');
  assert.equal(classifyGame(mkGame([], ['抜きゲー'])), 'galgame');
});
test('classifyGame: 视觉小说向别名（文字冒险游戏/互动小说/VN/乙女系）', () => {
  assert.equal(classifyGame(mkGame(['文字冒险游戏'], [])), 'galgame');
  assert.equal(classifyGame(mkGame([], ['互动小说'])), 'galgame');
  assert.equal(classifyGame(mkGame(['VN'], ['悬疑'])), 'galgame');
  assert.equal(classifyGame(mkGame([], ['乙女系', '恋爱'])), 'galgame');
});
test('classifyGame: AVG/ADV 不单独收录（塞尔达/大镖客/法环等主机欧美大作）', () => {
  assert.equal(classifyGame(mkGame(['AVG'], ['冒险'])), null);
  assert.equal(classifyGame(mkGameNamed('ゼルダの伝説 ブレス オブ ザ ワイルド', '塞尔达传说 旷野之息', ['AVG', 'AAVG'], ['开放世界'])), null);
  assert.equal(classifyGame(mkGameNamed('Red Dead Redemption 2', '荒野大镖客2', ['ADV', 'RPG'], ['开放世界'])), null);
  assert.equal(classifyGame(mkGameNamed('ELDEN RING', '艾尔登法环', ['AVG', 'RPG'], [])), null);
});
test('classifyGame: 主机/欧美大作带 Galgame/R18 玩笑标签仍排除（防灌库）', () => {
  assert.equal(classifyGame(mkGameNamed('ゼルダの伝説 時のオカリナ', '塞尔达传说 时之笛', ['RPG'], ['Galgame'])), null);
  assert.equal(classifyGame(mkGameNamed('メトロイド フュージョン', '密特罗德 融合', ['ACT'], ['Galgame', '非gal'])), null);
  assert.equal(classifyGame(mkGameNamed('ファイナルファンタジーX-2', '最终幻想 X-2', ['RPG'], ['Galgame'])), null);
  assert.equal(classifyGame(mkGameNamed('Crusader Kings III', '十字军之王3', ['SLG'], ['R18'])), null);
  assert.equal(classifyGame(mkGameNamed('ファイアーエムブレム if', '火焰之纹章if', ['SLG'], ['乙女向'])), null);
  assert.equal(classifyGame(mkGameNamed('ELDEN RING', '艾尔登法环', ['RPG'], ['视觉小说'])), null);
  assert.equal(classifyGame(mkGameNamed('Super Mario Odyssey', '超级马力欧 奥德赛', ['ACT'], ['Galgame'])), null);
  assert.equal(classifyGame(mkGameNamed('千年戦争アイギス', '千年战争Aigis', ['SLG'], ['R18'])), null);
  assert.equal(classifyGame(mkGameNamed('ペルソナ4 ジ・アルティマックス', '女神异闻录4 无敌究极背桥摔', ['FTG'], ['视觉小说'])), null);
  assert.equal(classifyGame(mkGameNamed('THE IDOLM@STER SP', '偶像大师 SP', ['SLG'], ['GAL'])), null);
});


test('regionsOf: 中日韩区域标签识别，无标签为空数组', () => {
  const r = regionsOf(mkBook('漫画', [], ['日本', '日常']));
  assert.deepEqual(r, ['日本']);
  assert.deepEqual(regionsOf(mkBook('漫画', [], ['日常'])), []);
});

// ---------- queryLibrary「近期注目」（sort=trends）排序语义 ----------
// 书籍的 air_date 是「系列首卷首发日」，latest_date 才是「最新一卷 / 最新发售日」（由 bookrelease 日历回写）。
// 语义：近 365 天内有新卷的排前面并按日期倒序；未来 180 天以外的脏日期不算近期；其余回落首卷日 + 热度兜底。
const T_ID_BASE = 900400001; // 独立假 ID 段
const dayStr = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function insTestBook(id, name, latest, ratingTotal, rank) {
  await pool.query(
    `INSERT INTO library_subjects (subject_id, category, name, name_cn, image, air_date, rating_score, rating_total, rank, platform, tags, regions, latest_date, blocked, updated_at)
     VALUES (?, 'manga', ?, ?, '', '1990-11-26', 8, ?, ?, '漫画', '[]', '["日本"]', ?, 0, ?)
     ON CONFLICT(subject_id, category) DO UPDATE SET name = excluded.name, latest_date = excluded.latest_date,
       rating_total = excluded.rating_total, rank = excluded.rank, blocked = 0, updated_at = excluded.updated_at`,
    [id, name, name, ratingTotal, rank, latest, Date.now()]);
}

test('queryLibrary sort=trends: 有新卷的压过老经典，脏未来日期不抢头名，未探明的回落热度', async () => {
  const RECENT = T_ID_BASE + 1;   // 有最新一卷（窗口内）
  const MIDDLE = T_ID_BASE + 2;   // 有最新一卷（刚过去不久）
  const OLDHOT = T_ID_BASE + 3;   // 老经典：没有 latest_date，热度最高
  const DIRTY = T_ID_BASE + 4;    // 库里脏日期 2099：既不是近期，也不该因为“日期最大”排前面
  await pool.query('DELETE FROM library_subjects WHERE subject_id >= ?', [T_ID_BASE]);
  await insTestBook(RECENT, '测试近期系列甲', dayStr(179), 1, 999999);
  await insTestBook(MIDDLE, '测试中间系列丁', dayStr(-10), 5, 500);
  await insTestBook(OLDHOT, '测试经典系列乙', '', 999999, 1);
  await insTestBook(DIRTY, '测试脏日期系列丙', '2099-01-01', 999998, 2);

  const out = await queryLibrary({ category: 'manga', sort: 'trends', keyword: '测试', limit: 10 });
  assert.deepEqual(out.data.map(x => x.id), [RECENT, MIDDLE, OLDHOT, DIRTY]);
  assert.equal(out.data[0].latest_date, dayStr(179), '接口要带出最新一卷日期');
  assert.equal(out.data[2].latest_date, '', '未探明的最新日期为空，前端按首卷日展示');

  // 其它排序不受影响：rank 仍按排名、rating 仍按评分
  const byRank = await queryLibrary({ category: 'manga', sort: 'rank', keyword: '测试', limit: 10 });
  assert.equal(byRank.data[0].id, OLDHOT);
  const byRating = await queryLibrary({ category: 'manga', sort: 'rating', keyword: '测试', limit: 10 });
  assert.equal(byRating.data[0].id, OLDHOT);
});

after(async () => {
  await pool.query('DELETE FROM library_subjects WHERE subject_id >= ?', [T_ID_BASE]);
});
