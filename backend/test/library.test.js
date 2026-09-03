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
test('classifyGame: 无视觉小说向标记 -> null（P5/塞尔达/逆转裁判等）', () => {
  assert.equal(classifyGame(mkGame(['游戏'], ['女神异闻录', 'RPG'])), null);
  assert.equal(classifyGame(mkGame([], ['冒险', '任天堂'])), null);
  assert.equal(classifyGame(mkGame(['悬疑'], ['推理'])), null);
  assert.equal(classifyGame(mkGame([], [])), null);
});
test('classifyGame: 与 classify 互不干扰（平台=游戏 不进书籍分类）', () => {
  assert.equal(classify(mkGame(['Galgame'])), null);
});

test('regionsOf: 中日韩区域标签识别，无标签为空数组', () => {
  const r = regionsOf(mkBook('漫画', [], ['日本', '日常']));
  assert.deepEqual(r, ['日本']);
  assert.deepEqual(regionsOf(mkBook('漫画', [], ['日常'])), []);
});
