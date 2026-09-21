// library.test.js - 本地内容库分类器单测（书籍 classify / 游戏 classifyGame）
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { classify, classifyGame, regionsOf, queryLibrary, suggestLibrary, rebuildAliases, writeAliasesForSubject } = require('../src/library');
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
// 语义：先用「最新一卷」判定算不算近期（窗口 -365d ~ +180d），近期池内按热度 rating_total 倒序；
// 未来 180 天以外（以及 2099 这类脏日期）不算近期，回落首卷日 + 热度兜底。
// 日期不做排序主键：书籍的 latest_date 多是「未开卖的新刊定档日」，倒序会变成「越晚才出越靠前」。
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

test('queryLibrary sort=trends: 近期池按热度排（不按日期倒序），脏未来日期不抢头名，未探明的回落热度', async () => {
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
  // 近期池内按热度：MIDDLE(5 票) 压过 RECENT(1 票)；两人都在池里，谁的最新卷日期更晚不影响名次。
  // 池外的 OLDHOT / DIRTY 热度再高也只能排在近期池之后。
  assert.deepEqual(out.data.map(x => x.id), [MIDDLE, RECENT, OLDHOT, DIRTY]);
  assert.equal(out.data[1].latest_date, dayStr(179), '接口要带出最新一卷日期');
  assert.equal(out.data[2].latest_date, '', '未探明的最新日期为空，前端按首卷日展示');

  // 其它排序不受影响：rank 仍按排名、rating 仍按评分
  const byRank = await queryLibrary({ category: 'manga', sort: 'rank', keyword: '测试', limit: 10 });
  assert.equal(byRank.data[0].id, OLDHOT);
  const byRating = await queryLibrary({ category: 'manga', sort: 'rating', keyword: '测试', limit: 10 });
  assert.equal(byRating.data[0].id, OLDHOT);
});

// ---------- 关联搜索：关键词同时匹配「标题」与「标签」 ----------
// 场景：想找某个作者的书，但作者名只存在于 tags 里（书名里没有），旧逻辑直接返回 0 条。
// 这里全部用假 ID 段 + 假关键词，跟真实库数据隔离（即使开发库里也有同名条目，断言只看自己的 ID）。
const T_ASSOC_BASE = 900500001;
const KW = 'zetaqtest';
const insTaggedBook = (id, name, tagsJson, rank) => pool.query(
  `INSERT INTO library_subjects (subject_id, category, name, name_cn, image, air_date, rating_score, rating_total, rank, platform, tags, regions, latest_date, blocked, updated_at)
   VALUES (?, 'manga', ?, ?, '', '1990-11-26', 8, 1, ?, '漫画', ?, '["日本"]', '', 0, ?)
   ON CONFLICT(subject_id, category) DO UPDATE SET name = excluded.name, name_cn = excluded.name_cn, tags = excluded.tags,
     rank = excluded.rank, blocked = 0, updated_at = excluded.updated_at`,
  [id, name, name, rank, tagsJson, Date.now()]);
const clearAssoc = () => pool.query('DELETE FROM library_subjects WHERE subject_id BETWEEN ? AND ?', [T_ASSOC_BASE, T_ASSOC_BASE + 99]);

test('queryLibrary 关联搜索: 标题命中排在标签命中前，顺序为「全等 > 前缀 > 包含 > 整标签 > 标签包含」', async () => {
  await clearAssoc();
  const EXACT = T_ASSOC_BASE + 1;    // 标题全等
  const PREFIX = T_ASSOC_BASE + 2;   // 标题前缀
  const INNAME = T_ASSOC_BASE + 3;   // 标题包含（非前缀）
  const WHOLETAG = T_ASSOC_BASE + 4; // 书名无关，整标签命中
  const SUBTAG = T_ASSOC_BASE + 5;   // 书名无关，标签子串命中
  // 故意乱序插入 + 把 rank 反过来给，确保排序真的是靠命中等级、不是靠 id/rank 巧合
  await insTaggedBook(SUBTAG, '完全无关的书名丙', '["' + KW + '作者"]', 1);
  await insTaggedBook(WHOLETAG, '完全无关的书名乙', '["' + KW + '"]', 2);
  await insTaggedBook(INNAME, '中缀 ' + KW + ' 甲', '[]', 3);
  await insTaggedBook(PREFIX, KW + ' 前缀甲', '[]', 4);
  await insTaggedBook(EXACT, KW, '[]', 5);

  const out = await queryLibrary({ category: 'manga', keyword: KW, sort: 'rank', limit: 20 });
  assert.deepEqual(out.data.map(x => x.id), [EXACT, PREFIX, INNAME, WHOLETAG, SUBTAG]);
  assert.equal(out.total, 5, '标签关联的条目要计入 total');
  assert.equal(out.titleMatches, 3, 'titleMatches 只数书名命中的 3 条');
  assert.equal(out.data[0].titleMatches, undefined, 'titleMatches 是整体字段，不重复塞进每条');

  // 「这条为什么会出现」：书名自己命中的不该再挂 matched_tags，靠标签进来的必须挂上
  assert.deepEqual(out.data[0].matched_tags, []);
  assert.deepEqual(out.data[1].matched_tags, []);
  assert.deepEqual(out.data[2].matched_tags, []);
  assert.deepEqual(out.data[3].matched_tags, [KW]);
  assert.deepEqual(out.data[4].matched_tags, [KW + '作者']);

  // 切换排序：命中等级永远压在最前，用户选的排序只在其内部生效
  for (const sort of ['trends', 'rating', 'title']) {
    const o = await queryLibrary({ category: 'manga', keyword: KW, sort, limit: 20 });
    assert.deepEqual(o.data.map(x => x.id), [EXACT, PREFIX, INNAME, WHOLETAG, SUBTAG], 'sort=' + sort + ' 也应保持命中等级');
  }

  // 无关键词时是纯浏览：titleMatches 退化成 total，SQL 与加这个功能之前一致
  const browse = await queryLibrary({ category: 'manga', limit: 3 });
  assert.equal(browse.titleMatches, browse.total);
});

test('queryLibrary 关联搜索: 单字关键词只认「整标签」子串，不退化成标签内包含（防结果灌水）', async () => {
  await clearAssoc();
  const TAGSUB = T_ASSOC_BASE + 11;  // tags 里只有「ζ关联」，不该被单字 ζ 捞出来
  const TAGWHOLE = T_ASSOC_BASE + 12; // 整个标签就是 ζ，算命中
  const TITLEHIT = T_ASSOC_BASE + 13; // 书名带 ζ，单字也该照常命中书名
  await insTaggedBook(TAGSUB, '单字测试书甲', '["ζ关联"]', 1);
  await insTaggedBook(TAGWHOLE, '单字测试书乙', '["ζ"]', 2);
  await insTaggedBook(TITLEHIT, 'ζ 标题命中丙', '[]', 3);

  const out = await queryLibrary({ category: 'manga', keyword: 'ζ', limit: 20 });
  const ids = out.data.map(x => x.id);
  assert.ok(ids.includes(TAGWHOLE), '整标签等于关键词要命中');
  assert.ok(ids.includes(TITLEHIT), '单字关键词仍然照常搜书名');
  assert.ok(!ids.includes(TAGSUB), '单字不许做标签子串匹配，否则「分」「人」会拖出几百条无关作品');
  assert.equal(out.titleMatches, 1);
  assert.equal(out.total, 2);
  assert.deepEqual(out.data.find(x => x.id === TAGWHOLE).matched_tags, ['ζ']);
  assert.deepEqual(out.data.find(x => x.id === TITLEHIT).matched_tags, []);
});

test('queryLibrary 关联搜索: LIKE 通配符/引号等特殊字符不报错、不越权匹配', async () => {
  // 用户（或爬虫）在搜索框里敲 % _ \ " ' 这类字符时，不能被当成通配符逃逸出去
  for (const kw of ['100%', 'a_b', '\\', '"', "'", '%', '_', '%%', '[]', 'ζ%']) {
    const out = await queryLibrary({ category: 'manga', keyword: kw, limit: 5 });
    assert.ok(Array.isArray(out.data), 'keyword=' + JSON.stringify(kw) + ' 应正常返回');
    assert.ok(typeof out.titleMatches === 'number' && out.titleMatches >= 0);
    assert.ok(out.total >= out.titleMatches);
  }
});


// ---- 别名索引 / 搜索联想（search-as-you-type）----
// 别名来源只有 ext.vndb（零外部请求）：title=罗马字/英文名、alttitle=日文原名、aliases=官方别名。
// Bangumi 自己的「别名 / 罗马字」在 infobox 里、没同步下来，要逐条打 API 才能拿，所以不在这条链路上。
const T_ALIAS_BASE = 900600001;
const ALIAS_KW = 'zetaliasq';
const insGalgame = (id, name, nameCn, ext, tags) => pool.query(
  `INSERT INTO library_subjects (subject_id, category, name, name_cn, image, air_date, rating_score, rating_total, rank, platform, tags, regions, latest_date, blocked, ext, updated_at)
   VALUES (?, 'galgame', ?, ?, '', '2003-02-28', 8.5, 100, 100, '游戏', ?, '["日本"]', '', 0, ?, ?)
   ON CONFLICT(subject_id, category) DO UPDATE SET name = excluded.name, name_cn = excluded.name_cn, tags = excluded.tags,
     ext = excluded.ext, blocked = 0, updated_at = excluded.updated_at`,
  [id, name, nameCn, tags, ext, Date.now()]);
const clearAlias = async () => {
  await pool.query('DELETE FROM library_aliases WHERE subject_id BETWEEN ? AND ?', [T_ALIAS_BASE, T_ALIAS_BASE + 99]);
  await pool.query('DELETE FROM library_subjects WHERE subject_id BETWEEN ? AND ?', [T_ALIAS_BASE, T_ALIAS_BASE + 99]);
};

test('queryLibrary 别名检索: 罗马字 / 英文别名 / 空格变体与日文原名都能命中，并给出「又名」', async () => {
  await clearAlias();
  const ID = T_ALIAS_BASE + 1;
  const ext = JSON.stringify({ vndb: { id: 'v9001', title: 'Gyakuten Saiban 3', alttitle: '逆転裁判3', aliases: ['AA3', 'Phoenix Wright: Ace Attorney 3'] } });
  await insGalgame(ID, '逆転裁判3', '逆转裁判3', ext, '[]');
  await writeAliasesForSubject(ID, 'galgame', ext);

  // 罗马字：name / name_cn 里根本没有这个词，靠 ext.vndb.title 找回来
  const romaji = await queryLibrary({ category: 'galgame', keyword: 'Gyakuten Saiban 3', limit: 5 });
  const hit = romaji.data.find(x => x.id === ID);
  assert.ok(hit, '罗马字别名要能搜到');
  assert.deepEqual(hit.matched_aliases, ['Gyakuten Saiban 3']);
  assert.deepEqual(hit.matched_tags, []);
  assert.equal(romaji.titleMatches, 0, '书名没命中就不该记到书名命中数上');
  assert.equal(romaji.aliasMatches, 1, '别名命中要单独报数，前端才解释得清结果为什么变多');

  // 官方别名 / 大小写 / 空格变体（Muv-Luv 与 MuvLuv 这类写法差异）
  for (const kw of ['AA3', 'aa3', 'Phoenix Wright: Ace Attorney 3', '逆転裁判 3']) {
    const out = await queryLibrary({ category: 'galgame', keyword: kw, limit: 5 });
    assert.ok(out.data.some(x => x.id === ID), kw + ' 应该命中同一条');
  }
  // 书名自己命中时不再挂「命中的别名」，否则每条都挂一堆解释文案
  const byTitle = await queryLibrary({ category: 'galgame', keyword: '逆転裁判3', limit: 5 });
  const t = byTitle.data.find(x => x.id === ID);
  assert.ok(t && byTitle.titleMatches >= 1);
  assert.deepEqual(t.matched_aliases, []);
  // 单字不许在别名上做子串匹配（「A」不该把别名 AA3 捞出来）
  const single = await queryLibrary({ category: 'galgame', keyword: 'A', limit: 20 });
  assert.ok(!single.data.some(x => x.id === ID), '单字只在别名上做精确匹配');
});

test('别名索引: 重新回填会清掉旧别名（改绑 VNDB 条目不留幽灵命中）', async () => {
  await clearAlias();
  const ID = T_ALIAS_BASE + 2;
  const ext1 = JSON.stringify({ vndb: { id: 'v1', title: 'Old Title QQ', alttitle: '', aliases: [] } });
  await insGalgame(ID, '幽灵测试条目标题', '幽灵测试条目', ext1, '[]');
  await writeAliasesForSubject(ID, 'galgame', ext1);
  assert.ok((await queryLibrary({ category: 'galgame', keyword: 'Old Title QQ', limit: 5 })).data.some(x => x.id === ID));

  const ext2 = JSON.stringify({ vndb: { id: 'v2', title: 'New Title QQ', alttitle: '', aliases: [] } });
  await pool.query("UPDATE library_subjects SET ext = ? WHERE subject_id = ? AND category = 'galgame'", [ext2, ID]);
  await writeAliasesForSubject(ID, 'galgame', ext2);
  assert.ok(!(await queryLibrary({ category: 'galgame', keyword: 'Old Title QQ', limit: 5 })).data.some(x => x.id === ID),
    '换绑后旧别名不该还留在索引里');
  assert.ok((await queryLibrary({ category: 'galgame', keyword: 'New Title QQ', limit: 5 })).data.some(x => x.id === ID));
});

test('rebuildAliases: 内容没变就跳过、坏 ext 不炸、重建后的索引立刻可搜', async () => {
  await clearAlias();
  const ID = T_ALIAS_BASE + 3;
  const ext = JSON.stringify({ vndb: { id: 'v3', title: 'Rebuild Test Title', alttitle: '', aliases: ['RT Alias'] } });
  await insGalgame(ID, '重建测试条目标题', '重建测试条目', ext, '[]');
  // ext 里带 "vndb" 但 JSON 是坏的（历史脏数据/写坏的行）：重建只能跳过它，不能整轮失败
  await insGalgame(T_ALIAS_BASE + 4, '坏 ext 标题', '坏 ext 标题', '{"vndb": broken', '[]');

  const r1 = await rebuildAliases({ force: true });
  assert.equal(r1.error, undefined);
  assert.ok(r1.scanned >= 2);
  const [rows] = await pool.query('SELECT COUNT(*) AS n FROM library_aliases WHERE subject_id = ?', [ID]);
  assert.equal(rows[0].n, 2, '只认 ext.vndb 里的标题族（title + aliases）');
  const r2 = await rebuildAliases();
  assert.equal(r2.skipped, true, '指纹一致时整表重建应当直接跳过，不是每轮同步都重写整表');
  assert.ok((await queryLibrary({ category: 'galgame', keyword: 'RT Alias', limit: 5 })).data.some(x => x.id === ID));
});

test('suggestLibrary: 联想只查本地库，标出命中理由（书名/别名/标签），并顶住脏参数', async () => {
  await clearAlias();
  const TITLE = T_ALIAS_BASE + 11;
  const ALIASED = T_ALIAS_BASE + 12;
  const TAGGED = T_ALIAS_BASE + 13;
  await insGalgame(TITLE, ALIAS_KW + ' 标题命中', ALIAS_KW + ' 标题命中', '{}', '[]');
  const ext = JSON.stringify({ vndb: { id: 'v9', title: ALIAS_KW + ' Alias Name', alttitle: '', aliases: [] } });
  await insGalgame(ALIASED, '别名命中条目', '别名命中条目', ext, '[]');
  await writeAliasesForSubject(ALIASED, 'galgame', ext);
  await insGalgame(TAGGED, '标签关联条目', '标签关联条目', '{}', '["' + ALIAS_KW + '作者"]');

  const out = await suggestLibrary({ category: 'galgame', keyword: ALIAS_KW, limit: 10 });
  assert.equal(out.data.length, 3);
  assert.equal(out.data[0].id, TITLE, '书名命中要排在前面');
  assert.equal(out.data[0].via, 'title');
  const a = out.data.find(x => x.id === ALIASED);
  assert.equal(a.via, 'alias');
  assert.equal(a.alias, ALIAS_KW + ' Alias Name');
  assert.equal(a.type, 4, '游戏分类按 Bangumi 类型 4 返回，卡片才显示「游戏」');
  const g = out.data.find(x => x.id === TAGGED);
  assert.equal(g.via, 'tag');
  assert.deepEqual(g.matched_tags, [ALIAS_KW + '作者']);

  // 单字也要能联想（书名照旧 LIKE；别名/标签在单字时只做精确匹配，防灌水）
  const single = await suggestLibrary({ category: 'galgame', keyword: '标', limit: 10 });
  assert.ok(single.data.some(x => x.id === TITLE), '单个汉字也要能出联想结果');

  // 脏参数：数组 category（?category[]=x）、原型链键（constructor）、注入串、空词、负数 limit
  assert.ok((await suggestLibrary({ category: 'galgame', keyword: ALIAS_KW, limit: -5 })).data.length <= 1);
  assert.deepEqual((await suggestLibrary({ category: { evil: 1 }, keyword: ALIAS_KW })).data, []);
  assert.deepEqual((await suggestLibrary({ category: '123', keyword: ALIAS_KW })).data, []);
  assert.equal((await suggestLibrary({ category: ['galgame'], keyword: ALIAS_KW })).category, 'galgame',
    '?category[]=galgame 这类数组参数取第一个元素（与 Express 的正常行为一致）');
  assert.deepEqual((await suggestLibrary({ category: 'constructor', keyword: ALIAS_KW })).data, []);
  assert.deepEqual((await suggestLibrary({ category: 'galgame', keyword: '   ' })).data, []);
  const inj = await suggestLibrary({ category: 'galgame', keyword: "' OR 1=1 --" });
  assert.ok(!inj.data.some(x => x.id >= T_ALIAS_BASE), '注入串不该把整表捞出来');
});
after(async () => {
  await pool.query('DELETE FROM library_subjects WHERE subject_id >= ?', [T_ID_BASE]);
  await pool.query('DELETE FROM library_aliases WHERE subject_id >= ?', [T_ID_BASE]);
});

