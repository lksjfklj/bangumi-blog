// library.test.js - 本地内容库分类器单测（书籍 classify / 游戏 classifyGame）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, classifyGame, regionsOf } = require('../src/library');

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

test('regionsOf: 中日韩区域标签识别，无标签为空数组', () => {
  const r = regionsOf(mkBook('漫画', [], ['日本', '日常']));
  assert.deepEqual(r, ['日本']);
  assert.deepEqual(regionsOf(mkBook('漫画', [], ['日常'])), []);
});
