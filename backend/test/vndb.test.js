// vndb.test.js - VNDB 标题匹配纯函数单测（不联网，覆盖跨语言对照与判定闸门）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTitle, scorePair, yearMatches, pickBestVn, matchDecision, summarizeVn
} = require('../src/vndb');

const mkVn = (id, title, released, extra = {}) => ({
  id, title,
  alttitle: extra.alttitle || '',
  titles: extra.titles || [],
  aliases: extra.aliases || [],
  released: released || '',
  rating: extra.rating || 75,
  votecount: extra.votecount || 100,
  popularity: extra.popularity || 50,
  platforms: extra.platforms || ['win'],
  developers: extra.developers || [{ name: 'Key' }],
  olang: extra.olang || 'ja',
  image: extra.image || { url: 'https://t.vndb.org/sf/00/1.jpg' },
  length: extra.length || 10
});

test('normalizeTitle: NFKC + 去标点/空格/大小写', () => {
  assert.equal(normalizeTitle('CLANNAD'), 'clannad');
  assert.equal(normalizeTitle('ＣＬＡＮＮＡＤ'), 'clannad'); // 全角
  assert.equal(normalizeTitle('こみっくパーティー'), 'こみっくパーティー');
  assert.equal(normalizeTitle('  AIR  ~ Season~ '), 'airseason');
  assert.equal(normalizeTitle(''), '');
});

test('scorePair: 全等=1、包含关系>0.65、无交集=0', () => {
  assert.equal(scorePair('clannad', 'clannad'), 1);
  assert.ok(scorePair('clannad', 'clannadtomoyoafter') >= 0.65);
  assert.ok(scorePair('abc', 'xyz') < 0.3);
});

test('yearMatches: 年份取 released 前 4 位；无年份/无 released 返回 null', () => {
  assert.equal(yearMatches({ released: '2004-04-28' }, '2004'), true);
  assert.equal(yearMatches({ released: '2005-01-01' }, '2004'), false);
  assert.equal(yearMatches({ released: '' }, '2004'), null);
  assert.equal(yearMatches({ released: '2004-04-28' }, ''), null);
});

test('pickBestVn: 中文名/日文名/罗马音跨语言对照都应收敛到同一 vndb 条目', () => {
  const results = [
    mkVn('v66', 'Comic Party', '2001-05-25', {
      titles: [
        { lang: 'ja', title: 'こみっくパーティー' },
        { lang: 'en', latin: 'Comic Party' }
      ],
      aliases: ['コミパ', 'ComicParty']
    }),
    mkVn('v999', 'Comic Party Portable', '2005-01-01', {}) // 干扰项
  ];
  const viaJa = pickBestVn(results, { names: ['こみっくパーティー'], year: '2001' });
  assert.equal(viaJa.vn.id, 'v66');
  assert.equal(viaJa.score, 1);
  assert.equal(viaJa.yearOk, true);
  const viaEn = pickBestVn(results, { names: ['Comic Party'], year: '2001' });
  assert.equal(viaEn.vn.id, 'v66');
});

test('pickBestVn: 干扰条目（月姫等）不会抢走精确命中的 AIR', () => {
  const results = [
    mkVn('v36', 'AIR', '2000-09-08', { alttitle: 'エアー', aliases: ['Air (2000)'] }),
    mkVn('v77', '月姫', '2000-12-29', { aliases: ['Tsukihime', 'AIR 无关项'] })
  ];
  const pick = pickBestVn(results, { names: ['AIR'], year: '2000' });
  assert.equal(pick.vn.id, 'v36');
});

test('matchDecision: 精确/高相似+年份一致通过；年份冲突/低相似拒绝', () => {
  assert.equal(matchDecision({ score: 1, yearOk: true }).ok, true);
  assert.equal(matchDecision({ score: 1, yearOk: null }).ok, true); // 无年份只靠相似度
  assert.equal(matchDecision({ score: 0.93, yearOk: true }).ok, true);
  assert.equal(matchDecision({ score: 0.93, yearOk: null }).ok, true); // 高相似且无年份不冲突
  assert.equal(matchDecision({ score: 0.93, yearOk: false }).ok, false); // 高相似但年份明确冲突
  assert.equal(matchDecision({ score: 0.85, yearOk: true }).ok, true);  // 中相似+年份一致
  assert.equal(matchDecision({ score: 0.85, yearOk: false }).ok, false);
  assert.equal(matchDecision({ score: 0.5, yearOk: true }).ok, false);
  assert.equal(matchDecision(null).ok, false);
});

test('summarizeVn: 收敛为入库用的精简结构', () => {
  const s = summarizeVn(mkVn('v1', 'CLANNAD', '2004-04-28', { developers: [{ name: 'Key' }, { name: 'VisualArts' }], aliases: ['クラナド'], platforms: ['win', 'psp'] }));
  assert.equal(s.id, 'v1');
  assert.deepEqual(s.developers, ['Key', 'VisualArts']);
  assert.deepEqual(s.platforms, ['win', 'psp']);
  assert.ok(Array.isArray(s.aliases));
  assert.ok(s.image.includes('t.vndb.org'));
});
